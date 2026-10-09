// SPDX-License-Identifier: Apache-2.0
import versions from "../../platform/versions.lock.json" with {type:"json"};
export interface SwapQualificationInput {machine_type:"worker"|"controlplane";isolated_worker_accepted:boolean;talos_version:string;kubernetes_version:string;largest_verified_tail_bytes:number;swap_bytes:number;passphrase:string;zswap_percent?:number;}
/** Render only; this cannot apply, shrink, replace or format an existing volume. Secret output stays in sealed custody. */
export function encryptedSwapDocuments(input:SwapQualificationInput){
 if(input.machine_type!=="worker"||!input.isolated_worker_accepted)throw Error("warm_reclaim_worker_not_qualified");
 if(input.talos_version!==versions.target.talosVersion||input.kubernetes_version!==versions.target.kubernetesVersion)throw Error("warm_reclaim_software_not_qualified");
 if(!Number.isSafeInteger(input.largest_verified_tail_bytes)||!Number.isSafeInteger(input.swap_bytes)||input.swap_bytes<128*1048576||input.swap_bytes%1048576!==0||input.swap_bytes>input.largest_verified_tail_bytes)throw Error("warm_reclaim_unpartitioned_space_unavailable");
 if(!/^[A-Za-z0-9_-]{43}$/.test(input.passphrase))throw Error("warm_reclaim_private_random_swap_key_required");
 if(input.zswap_percent!==undefined&&(!Number.isInteger(input.zswap_percent)||input.zswap_percent<1||input.zswap_percent>20))throw Error("warm_reclaim_zswap_budget_invalid");
 const size=`${input.swap_bytes/1048576}MiB`;
 return {machine_patch:{machine:{kubelet:{extraConfig:{failSwapOn:false,memorySwap:{swapBehavior:"LimitedSwap"}}}}},documents:[{apiVersion:"v1alpha1",kind:"SwapVolumeConfig",name:"pgcf-swap",provisioning:{diskSelector:{match:"system_disk"},grow:false,minSize:size,maxSize:size},encryption:{provider:"luks2",allowDiscards:false,keys:[{slot:0,static:{passphrase:input.passphrase}}]}},...(input.zswap_percent===undefined?[]:[{apiVersion:"v1alpha1",kind:"ZswapConfig",maxPoolPercent:input.zswap_percent,shrinkerEnabled:true}])]};
}
