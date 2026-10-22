// SPDX-License-Identifier: Apache-2.0
//! The desired page of the node (plan 5.3, 5.6): its databases, release, policy and orders.
use super::request::Api;
use crate::{Error, diagnostics::probe::Request, node_link::desired_page_valid};
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
/// is open on every page until its result is reported. A property of an order that this build does
/// not name is ignored; a type of order it does not name is no order (`ORDER_TYPES`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
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
/// The types of order this build reads: the variants of `Order`, which are the contract's
/// `NODE_ORDER_TYPES` (a test holds the two equal). A page with another type is refused whole.
const ORDER_TYPES: [&str; 5] = ["wake", "move", "superseded", "fence", "maintenance"];

/// Whether a page holds an order of a type this build does not read. An order the agent does not
/// understand is never skipped as done, and it is never acted on beside the rest of its page: the
/// orders of a page carry the meaning of the entries beside them (a fenced node's page holds no
/// database, a `superseded` order retires what the page does not serve), so the agent that cannot
/// read every order of a page acts on none of it, keeps what runs, and says why. The API sends a
/// new type only in the release after every node reads it (plan 9.3, "Changing the page").
fn has_unknown_order(page: &Value) -> bool {
    page["orders"].as_array().is_some_and(|orders| {
        orders
            .iter()
            .filter_map(|order| order["type"].as_str())
            .any(|kind| !ORDER_TYPES.contains(&kind))
    })
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
    /// The probes an administrator asked for that Cloudflare has no result of (SEC-09), merged by
    /// identifier like the orders.
    pub diagnostics: Vec<Request>,
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
            .field("diagnostics", &self.diagnostics.len())
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
        for request in later.diagnostics {
            if self.diagnostics.iter().all(|held| held.id != request.id) {
                self.diagnostics.push(request);
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
    if has_unknown_order(&page) {
        return Err("Cloudflare desired page has an order this agent does not know".into());
    }
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
        diagnostics: match page.get("diagnostics") {
            Some(requests) => serde_json::from_value(requests.clone())?,
            None => Vec::new(),
        },
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
    use crate::{
        diagnostics::probe::Probe,
        link::{
            request::tests::enrolled,
            test_server::{Cloud, database, database_id, vector},
        },
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
    async fn the_probes_of_the_pages_are_pulled_once_each_and_a_page_without_any_has_none() {
        let cloud = Cloud::start().await;
        let (api, _) = enrolled(&cloud).await;
        cloud.with(|inner| inner.databases = (0..450).map(|i| database(&database_id(i))).collect());
        assert!(pull(&api, None).await.unwrap().diagnostics.is_empty());
        let request = |id: &str, probe: &str| json!({"id": id, "probe": probe, "boot": -1, "since_seconds": 600, "lines": 50});
        cloud.with(|inner| {
            inner.diagnostics = vec![
                request("5b1f0c2e-7d34-4a8b-9e61-0c3d2a4f6b81", "kernel"),
                request("6c2a1d3f-8e45-4b9c-af72-1d4e3b5a7c92", "pool"),
            ];
        });
        // Every one of the three pages lists both, and the pull has each once, in the page's order.
        let desired = pull(&api, None).await.unwrap();
        assert_eq!(
            desired.diagnostics,
            vec![
                Request {
                    id: "5b1f0c2e-7d34-4a8b-9e61-0c3d2a4f6b81".into(),
                    probe: Probe::Kernel,
                    boot: -1,
                    since_seconds: 600,
                    lines: 50,
                },
                Request {
                    id: "6c2a1d3f-8e45-4b9c-af72-1d4e3b5a7c92".into(),
                    probe: Probe::Pool,
                    boot: -1,
                    since_seconds: 600,
                    lines: 50,
                },
            ]
        );
        assert_eq!(get_targets(&cloud).len(), 6);
        // A request the contract does not have makes the page invalid, not a command to run.
        cloud.with(|inner| inner.diagnostics[0]["probe"] = "shell".into());
        assert_eq!(
            pull(&api, None).await.unwrap_err().to_string(),
            "Cloudflare desired page invalid"
        );
        // A property the contract does not have is no command either: the agent builds the command
        // of a probe itself, and a request is its name and three integers.
        cloud.with(|inner| {
            inner.diagnostics[0]["probe"] = "kernel".into();
            inner.diagnostics[0]["command"] = "id".into();
        });
        let desired = pull(&api, None).await.unwrap();
        assert_eq!(
            desired.diagnostics[0],
            Request {
                id: "5b1f0c2e-7d34-4a8b-9e61-0c3d2a4f6b81".into(),
                probe: Probe::Kernel,
                boot: -1,
                since_seconds: 600,
                lines: 50,
            }
        );
    }

    /// The largest database entry the contract allows: 100 roles with every attribute, each a
    /// member of 8 others, with names of the longest length.
    fn maxed(id: &str) -> Value {
        let name = |i: usize| format!("r{i:062}");
        let mut roles =
            vec![json!({"name":"app","owner":true,"password":"p".repeat(43),"revision":1})];
        for i in 0..99 {
            let member_of: Vec<String> = (1..=8).map(|n| name((i + n) % 99)).collect();
            roles.push(json!({"name":name(i),"owner":false,"password":"q".repeat(43),"revision":i + 1,
                "valid_until":"2031-01-02T03:04:05.678Z","connection_limit":10000,"member_of":member_of,"bypass_rls":true}));
        }
        let mut db = database(id);
        db["roles"] = roles.into();
        db
    }

    #[tokio::test]
    async fn a_page_of_the_most_the_contract_allows_is_pulled() {
        let cloud = Cloud::start().await;
        let (api, _) = enrolled(&cloud).await;
        // The largest page the contract allows: 200 databases of 100 roles and 1,000 open orders.
        let orders: Vec<Value> = (0..1000)
            .map(|i| json!({"type":"wake","operation":format!("op_{i:020}"),"database":database_id(i % 200),"generation":6}))
            .collect();
        cloud.with(|inner| {
            inner.databases = (0..200).map(|i| maxed(&database_id(i))).collect();
            inner.orders = orders;
        });
        let size = serde_json::to_vec(&maxed(&database_id(0))).unwrap().len();
        assert!(size * 200 > 15_000_000, "{size}");
        let desired = pull(&api, None).await.unwrap();
        assert!(desired.complete);
        assert_eq!(desired.databases.len(), 200);
        assert_eq!(desired.orders.len(), 1000);
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

    /// The agent comes first when the contract names a new type of order: this fails until the
    /// agent reads it (and `Order` has its variant), which is the first of the two releases.
    #[test]
    fn the_types_of_order_this_build_reads_are_the_contracts() {
        let contract: Vec<&str> = crate::node_link::constant("NODE_ORDER_TYPES")
            .as_array()
            .unwrap()
            .iter()
            .map(|kind| kind.as_str().unwrap())
            .collect();
        assert_eq!(ORDER_TYPES.to_vec(), contract);
        for kind in ORDER_TYPES {
            let order = json!({"type": kind, "operation": "op_oooooooooooooooooooo",
                "database": database_id(0), "generation": 1, "storage_generation": 1,
                "remove_volume": false});
            assert!(
                !has_unknown_order(&json!({"orders": [order.clone()]})),
                "{kind}"
            );
            assert!(serde_json::from_value::<Order>(order).is_ok(), "{kind}");
        }
        assert!(has_unknown_order(&json!({"orders": [{"type": "reboot"}]})));
    }

    #[test]
    fn every_order_of_the_contract_parses_and_a_type_it_does_not_have_does_not() {
        let page = vector("NodeDesiredPage", "full-page");
        let orders: Vec<Order> = serde_json::from_value(page["orders"].clone()).unwrap();
        assert_eq!(orders.len(), 4);
        // A property it does not know is ignored; a type it does not know is no order.
        let mut extra = page["orders"][0].clone();
        extra["slot"] = 1.into();
        assert_eq!(serde_json::from_value::<Order>(extra).unwrap(), orders[0]);
        assert!(
            serde_json::from_value::<Order>(json!({"type":"reboot","operation":"op_x"})).is_err()
        );
    }

    /// A page of a later release carries a property this build does not know on its objects: the
    /// page, the policy and its groups, the release and its parts, an entry, a role, an order and
    /// a probe. Everything the node reads of it is what it reads of the page without them
    /// (plan 9.3, "Changing the page").
    #[tokio::test]
    async fn a_page_with_properties_this_build_does_not_know_is_pulled_and_they_change_nothing() {
        let cloud = Cloud::start().await;
        let (api, _) = enrolled(&cloud).await;
        cloud.with(|inner| {
            inner.databases = (0..3).map(|i| database(&database_id(i))).collect();
            inner.orders = vec![
                json!({"type":"wake","operation":"op_wwwwwwwwwwwwwwwwwwww","database":database_id(1),"generation":6}),
                json!({"type":"superseded","operation":"op_ssssssssssssssssssss","database":"zzzzzzzzzzzzzzzzzzzz","storage_generation":2,"remove_volume":true}),
                json!({"type":"move","operation":"op_vvvvvvvvvvvvvvvvvvvv","database":database_id(2),"storage_generation":1}),
                json!({"type":"maintenance","operation":"op_tttttttttttttttttttt"}),
            ];
            inner.diagnostics = vec![json!({"id": "5b1f0c2e-7d34-4a8b-9e61-0c3d2a4f6b81", "probe": "kernel", "boot": -1, "since_seconds": 600, "lines": 50})];
        });
        let plain = pull(&api, None).await.unwrap();
        cloud.with(|inner| inner.unknown_properties = true);
        let later = pull(&api, None).await.unwrap();
        let unknown = crate::link::test_server::UNKNOWN_PROPERTY;
        // The properties are on the page, down to a role and a part of the release ...
        assert_eq!(later.release[unknown], 1);
        assert_eq!(later.release["binaries"]["pgcf-agent"][unknown], 1);
        assert_eq!(later.release["os"]["host_files"][0][unknown], 1);
        assert_eq!(later.policy[unknown], 1);
        assert_eq!(later.policy["admission"][unknown], 1);
        assert_eq!(later.databases[0][unknown], 1);
        assert_eq!(later.databases[0]["roles"][0][unknown], 1);
        // ... and the node reads what it reads without them.
        assert_eq!(later.orders, plain.orders);
        assert_eq!(later.orders.len(), 4);
        assert_eq!(later.diagnostics, plain.diagnostics);
        assert_eq!(later.diagnostics.len(), 1);
        assert_eq!(later.credentials_revision, plain.credentials_revision);
        assert_eq!(
            crate::update::Release::parse(&later.release),
            crate::update::Release::parse(&plain.release)
        );
        assert!(crate::update::Release::parse(&later.release).is_some());
        assert_eq!(
            format!("{:?}", crate::agent::Policy::parse(&later.policy)),
            format!("{:?}", crate::agent::Policy::parse(&plain.policy))
        );
        assert!(crate::agent::Policy::parse(&later.policy).is_some());
        assert_eq!(later.databases.len(), plain.databases.len());
        for (later, plain) in later.databases.iter().zip(&plain.databases) {
            assert_eq!(
                crate::agent::Entry::parse(later),
                crate::agent::Entry::parse(plain)
            );
            assert!(crate::agent::Entry::parse(later).is_some());
        }
    }

    /// What the node cannot read it refuses whole, as before: a type, a kind or a value it does
    /// not know, a property it needs that is missing, and one of the wrong type or out of bound.
    /// An order it does not know is never skipped as done, and the refusal says so.
    #[tokio::test]
    async fn a_page_the_node_cannot_read_is_refused_whole_and_an_unknown_order_says_so() {
        let cloud = Cloud::start().await;
        let (api, _) = enrolled(&cloud).await;
        cloud.with(|inner| inner.databases = vec![database(&database_id(0))]);
        let refused = |what: &str, error: Error, text: &str, class: &str| {
            assert_eq!(error.to_string(), text, "{what}");
            assert_eq!(crate::diagnostics::error_code(&error), class, "{what}");
        };
        let invalid = |what: &str, error: Error| {
            refused(
                what,
                error,
                "Cloudflare desired page invalid",
                "cloudflare_desired_page_invalid",
            )
        };
        // An order of a type this build does not have, whatever else the page holds.
        for order in [
            json!({"type":"reboot","operation":"op_rrrrrrrrrrrrrrrrrrrr"}),
            json!({"type":"quarantine","operation":"op_qqqqqqqqqqqqqqqqqqqq","database":database_id(0)}),
            json!({"type":"future"}),
        ] {
            cloud.with(|inner| {
                inner.orders = vec![
                    json!({"type":"maintenance","operation":"op_tttttttttttttttttttt"}),
                    order.clone(),
                ]
            });
            refused(
                "unknown order",
                pull(&api, None).await.unwrap_err(),
                "Cloudflare desired page has an order this agent does not know",
                "cloudflare_desired_page_has_an_order_this_agent_does_not_know",
            );
        }
        // An order it knows, with what it needs missing, of the wrong type or out of bound.
        for order in [
            json!({"type":"wake","database":database_id(1),"generation":6}),
            json!({"type":"wake","operation":"op_wwwwwwwwwwwwwwwwwwww","database":database_id(1),"generation":"6"}),
            json!({"type":"wake","operation":"op_wwwwwwwwwwwwwwwwwwww","database":database_id(1),"generation":0}),
            json!({"type":"superseded","operation":"op_ssssssssssssssssssss","database":database_id(1),"storage_generation":2}),
        ] {
            cloud.with(|inner| inner.orders = vec![order.clone()]);
            invalid("order", pull(&api, None).await.unwrap_err());
        }
        cloud.with(|inner| inner.orders.clear());
        // A value of a closed set it does not know.
        for change in [
            |db: &mut Value| db["desired_state"] = "paused".into(),
            |db: &mut Value| db["origin"] = json!({"kind":"clone"}),
            |db: &mut Value| db["pg_major"] = 19.into(),
        ] {
            cloud.with(|inner| change(&mut inner.databases[0]));
            invalid("entry", pull(&api, None).await.unwrap_err());
            cloud.with(|inner| inner.databases = vec![database(&database_id(0))]);
        }
        // A policy without a property it needs, with one of the wrong type, out of bound or a rule
        // it does not know.
        let example = vector("NodeDesiredPage", "full-page")["policy"].clone();
        for change in [
            |p: &mut Value| {
                p["admission"]
                    .as_object_mut()
                    .unwrap()
                    .remove("start_concurrency");
            },
            |p: &mut Value| p["admission"]["queue_wait_ms"] = "10000".into(),
            |p: &mut Value| p["admission"]["start_concurrency"] = 65.into(),
            |p: &mut Value| p["admission"]["cpu_boost_ms"] = 60_001.into(),
            |p: &mut Value| p["admission"]["memory_rule"] = "elastic".into(),
            |p: &mut Value| {
                p.as_object_mut().unwrap().remove("io");
            },
        ] {
            let mut policy = example.clone();
            change(&mut policy);
            cloud.with(|inner| inner.policy = Some(policy));
            invalid("policy", pull(&api, None).await.unwrap_err());
        }
        // A release without a binary it installs, or with a host file of a kind it does not have.
        let release = vector("NodeDesiredPage", "full-page")["release"].clone();
        for change in [
            |r: &mut Value| {
                r["binaries"].as_object_mut().unwrap().remove("pgcf-agent");
            },
            |r: &mut Value| r["binaries"]["pgcf-archive"]["size_bytes"] = "1000".into(),
            |r: &mut Value| r["os"]["host_files"][0]["kind"] = "directory".into(),
            |r: &mut Value| {
                r.as_object_mut().unwrap().remove("image");
            },
        ] {
            let mut release = release.clone();
            change(&mut release);
            cloud.with(|inner| {
                inner.policy = None;
                inner.release = Some(release)
            });
            invalid("release", pull(&api, None).await.unwrap_err());
        }
        // The page that was read stays readable: nothing above left the double changed.
        cloud.with(|inner| inner.release = None);
        assert!(pull(&api, None).await.is_ok());
    }
}
