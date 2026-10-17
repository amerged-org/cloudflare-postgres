// SPDX-License-Identifier: Apache-2.0
//! The desired page of the node (plan 5.3, 5.6): its databases, release, policy and orders.
use super::request::Api;
use crate::{Error, node_link::desired_page_valid};
use pgcf_native_protocol::valid_pattern;
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashSet, time::Duration};

/// A pull of named databases asks for at most this many. The signed path of a request may be 1,024
/// characters (`NodeRequestClaims`), which holds 47 identifiers; more databases are pulled whole.
pub(super) const IDS_PER_PULL: usize = 40;
/// Databases per page: `NODE_DESIRED_PAGE_LIMIT_MAX`.
const PAGE_LIMIT: usize = 200;
/// The pages of a full pull: 10,000 databases, the most volumes one node reports.
const MAX_PAGES: usize = 50;
const PULL_TIMEOUT: Duration = Duration::from_secs(60);

/// An explicit order of Cloudflare (`NodeOrder`). Nothing else stops or removes what runs. Each
/// is open on every page until its result is reported.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Order {
    /// Start the database now, through admission, as a connection's wake would (resume).
    Wake {
        operation: String,
        database: String,
        generation: u64,
    },
    /// The source of a move proves its sleep and holds its wakes until the order ends.
    Move {
        operation: String,
        database: String,
        storage_generation: u64,
    },
    /// Never start or archive this storage generation or an older one again.
    Superseded {
        operation: String,
        database: String,
        storage_generation: u64,
        remove_volume: bool,
    },
    /// The node was declared lost: start and archive nothing.
    Fence { operation: String },
    /// Hold new wakes, prove every sleep, install the release's packages, check.
    Maintenance { operation: String },
}
impl Order {
    pub fn operation(&self) -> &str {
        match self {
            Self::Wake { operation, .. }
            | Self::Move { operation, .. }
            | Self::Superseded { operation, .. }
            | Self::Fence { operation }
            | Self::Maintenance { operation } => operation,
        }
    }
}

/// What the node pulled: every page of a full pull, or the pages of the databases it asked for.
#[derive(Clone)]
pub struct Desired {
    /// `NodeRelease`, or null until a release is assigned.
    pub release: Value,
    /// `NodePolicy`.
    pub policy: Value,
    /// The revision of the node's credentials; read them when it is above the one applied.
    pub credentials_revision: u64,
    /// Every open order. The orders of two pages of one pull are merged by operation.
    pub orders: Vec<Order>,
    /// `NodeDesiredDatabase` entries, each once.
    pub databases: Vec<Value>,
    /// Every database of the node (a full pull) or only the ones asked for. A database that a full
    /// pull does not name is never stopped or deleted for that.
    pub complete: bool,
}

/// The entries carry the roles' credentials: a log line names their number only.
impl std::fmt::Debug for Desired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Desired")
            .field("credentials_revision", &self.credentials_revision)
            .field("orders", &self.orders)
            .field("databases", &self.databases.len())
            .field("complete", &self.complete)
            .finish()
    }
}
impl Desired {
    /// Takes in the page read after this one: its release, policy and credentials revision are
    /// newer, its orders add to the open ones.
    fn append(&mut self, later: Desired) {
        for order in later.orders {
            if self
                .orders
                .iter()
                .all(|held| held.operation() != order.operation())
            {
                self.orders.push(order);
            }
        }
        self.release = later.release;
        self.policy = later.policy;
        self.credentials_revision = later.credentials_revision;
        self.databases.extend(later.databases);
    }
}

/// Pulls the desired page: all of it (`None`), or the named databases.
pub(super) async fn pull(api: &Api, ids: Option<&[String]>) -> Result<Desired, Error> {
    tokio::time::timeout(PULL_TIMEOUT, async {
        match ids {
            Some([]) => Err("desired pull names no database".into()),
            Some(ids) if ids.len() <= IDS_PER_PULL => targeted(api, ids).await,
            _ => full(api).await,
        }
    })
    .await?
}

/// One page, checked as the contract and the node's own rules require, and its cursor.
async fn page(api: &Api, target: &str) -> Result<(Desired, Option<String>), Error> {
    let page = api.get(target).await?;
    if !desired_page_valid(&page) {
        return Err("Cloudflare desired page invalid".into());
    }
    let node = &api.identity().node;
    if page["node"]["id"] != node.id.as_str() || page["node"]["uid"] != node.uid.as_str() {
        return Err("Cloudflare desired page is for another node".into());
    }
    let desired = Desired {
        release: page["release"].clone(),
        policy: page["policy"].clone(),
        credentials_revision: page["credentials_revision"]
            .as_u64()
            .ok_or("desired credentials revision invalid")?,
        orders: serde_json::from_value(page["orders"].clone())?,
        databases: page["databases"].as_array().cloned().unwrap_or_default(),
        complete: false,
    };
    Ok((desired, page["next"].as_str().map(str::to_string)))
}

async fn targeted(api: &Api, ids: &[String]) -> Result<Desired, Error> {
    if ids.iter().any(|id| !valid_pattern("database", id)) {
        return Err("invalid desired database identifier".into());
    }
    let (desired, _) = page(api, &format!("/node/v1/desired?ids={}", ids.join(","))).await?;
    if desired
        .databases
        .iter()
        .any(|db| !ids.iter().any(|id| db["id"] == id.as_str()))
    {
        return Err("desired page names a database that was not asked for".into());
    }
    Ok(desired)
}

async fn full(api: &Api) -> Result<Desired, Error> {
    let mut cursor: Option<String> = None;
    let mut seen = HashSet::new();
    let mut pulled: Option<Desired> = None;
    for _ in 0..MAX_PAGES {
        let target = match &cursor {
            Some(after) => format!("/node/v1/desired?limit={PAGE_LIMIT}&after={after}"),
            None => format!("/node/v1/desired?limit={PAGE_LIMIT}"),
        };
        let (desired, next) = page(api, &target).await?;
        for db in &desired.databases {
            if !seen.insert(db["id"].as_str().unwrap_or_default().to_string()) {
                return Err("duplicate desired database".into());
            }
        }
        let held = match pulled.as_mut() {
            Some(held) => {
                held.append(desired);
                held
            }
            None => pulled.insert(desired),
        };
        let Some(next) = next else {
            held.complete = true;
            return pulled.ok_or_else(|| "desired pull is empty".into());
        };
        if cursor.as_ref() == Some(&next) {
            return Err("desired cursor did not advance".into());
        }
        cursor = Some(next);
    }
    Err("desired page count exceeds bound".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::{
        request::tests::enrolled,
        test_server::{Cloud, database, database_id, vector},
    };
    use serde_json::json;

    fn get_targets(cloud: &Cloud) -> Vec<String> {
        cloud
            .requests()
            .into_iter()
            .filter(|seen| seen.method == "GET")
            .map(|seen| seen.target)
            .collect()
    }
    fn ids(databases: &[Value]) -> Vec<String> {
        databases
            .iter()
            .map(|db| db["id"].as_str().unwrap().into())
            .collect()
    }

    #[tokio::test]
    async fn a_full_pull_walks_every_page_and_keeps_every_order_once() {
        let cloud = Cloud::start().await;
        let (api, _) = enrolled(&cloud).await;
        cloud.with(|inner| {
            inner.databases = (0..450).map(|i| database(&database_id(i))).collect();
            inner.orders = vec![
                json!({"type":"wake","operation":"op_wwwwwwwwwwwwwwwwwwww","database":database_id(1),"generation":6}),
                json!({"type":"maintenance","operation":"op_tttttttttttttttttttt"}),
                json!({"type":"superseded","operation":"op_ssssssssssssssssssss","database":"zzzzzzzzzzzzzzzzzzzz","storage_generation":2,"remove_volume":false}),
            ];
        });
        let desired = pull(&api, None).await.unwrap();
        assert!(desired.complete);
        assert_eq!(
            ids(&desired.databases),
            (0..450).map(database_id).collect::<Vec<_>>()
        );
        assert_eq!(get_targets(&cloud).len(), 3);
        assert_eq!(
            get_targets(&cloud)[1],
            format!("/node/v1/desired?limit=200&after={}", database_id(199))
        );
        assert_eq!(desired.credentials_revision, 3);
        assert_eq!(desired.release["id"], "release-25");
        assert_eq!(desired.policy["admission"]["start_concurrency"], 4);
        assert_eq!(
            desired.orders,
            vec![
                Order::Wake {
                    operation: "op_wwwwwwwwwwwwwwwwwwww".into(),
                    database: database_id(1),
                    generation: 6
                },
                Order::Maintenance {
                    operation: "op_tttttttttttttttttttt".into()
                },
                Order::Superseded {
                    operation: "op_ssssssssssssssssssss".into(),
                    database: "zzzzzzzzzzzzzzzzzzzz".into(),
                    storage_generation: 2,
                    remove_volume: false
                },
            ]
        );
    }

    #[tokio::test]
    async fn a_pull_of_named_databases_is_one_request_and_many_names_become_a_full_pull() {
        let cloud = Cloud::start().await;
        let (api, _) = enrolled(&cloud).await;
        cloud.with(|inner| inner.databases = (0..60).map(|i| database(&database_id(i))).collect());
        let wanted = vec![database_id(5), database_id(2)];
        let desired = pull(&api, Some(&wanted)).await.unwrap();
        assert!(!desired.complete);
        assert_eq!(ids(&desired.databases), [database_id(2), database_id(5)]);
        assert_eq!(
            get_targets(&cloud),
            [format!(
                "/node/v1/desired?ids={},{}",
                database_id(5),
                database_id(2)
            )]
        );
        // 41 names do not fit the signed path comfortably: the page size bounds a full pull instead.
        let many: Vec<String> = (0..=IDS_PER_PULL).map(database_id).collect();
        let desired = pull(&api, Some(&many)).await.unwrap();
        assert!(desired.complete);
        assert_eq!(desired.databases.len(), 60);
        // A name that is no database identifier is never sent.
        assert!(pull(&api, Some(&["../x".to_string()])).await.is_err());
        assert!(pull(&api, Some(&[])).await.is_err());
    }

    #[tokio::test]
    async fn a_page_for_another_node_or_against_the_page_rules_or_without_progress_is_refused() {
        let cloud = Cloud::start().await;
        let (api, _) = enrolled(&cloud).await;
        cloud.with(|inner| inner.databases = vec![database(&database_id(0))]);
        pull(&api, None).await.unwrap();
        cloud.with(|inner| inner.page_uid = "11111111-89ab-4def-8123-0123456789ab".into());
        assert_eq!(
            pull(&api, None).await.unwrap_err().to_string(),
            "Cloudflare desired page is for another node"
        );
        cloud.with(|inner| inner.page_uid = crate::link::test_server::NODE_UID.into());
        // An archive that is another database's.
        cloud.with(|inner| {
            let mut wrong = database(&database_id(1));
            wrong["archive"]["path"] = database(&database_id(2))["archive"]["path"].clone();
            inner.databases.push(wrong);
        });
        assert_eq!(
            pull(&api, None).await.unwrap_err().to_string(),
            "Cloudflare desired page invalid"
        );
        // A cursor that does not advance ends the walk.
        cloud.with(|inner| {
            inner.databases = (0..300).map(|i| database(&database_id(i))).collect();
            inner.stuck = true;
        });
        assert_eq!(
            pull(&api, None).await.unwrap_err().to_string(),
            "desired cursor did not advance"
        );
    }

    #[tokio::test]
    async fn a_fenced_node_pulls_the_fence_and_the_superseded_generations_and_no_database() {
        let cloud = Cloud::start().await;
        let (api, events) = enrolled(&cloud).await;
        let fenced = vector("NodeDesiredPage", "fenced-page");
        cloud.with(|inner| {
            inner.fenced = true;
            inner.orders = fenced["orders"].as_array().unwrap().clone();
        });
        let desired = pull(&api, None).await.unwrap();
        assert!(desired.release.is_null() && desired.databases.is_empty());
        assert_eq!(
            desired
                .orders
                .iter()
                .map(Order::operation)
                .collect::<Vec<_>>(),
            ["op_ffffffffffffffffffff", "op_ssssssssssssssssssss"]
        );
        assert!(matches!(desired.orders[0], Order::Fence { .. }));
        assert!(
            !events.fenced(),
            "the desired page is not refused to a fenced node"
        );
    }

    #[test]
    fn every_order_of_the_contract_parses_and_nothing_else_does() {
        let page = vector("NodeDesiredPage", "full-page");
        let orders: Vec<Order> = serde_json::from_value(page["orders"].clone()).unwrap();
        assert_eq!(orders.len(), 4);
        let mut extra = page["orders"][0].clone();
        extra["slot"] = 1.into();
        assert!(serde_json::from_value::<Order>(extra).is_err());
        assert!(
            serde_json::from_value::<Order>(json!({"type":"reboot","operation":"op_x"})).is_err()
        );
    }
}
