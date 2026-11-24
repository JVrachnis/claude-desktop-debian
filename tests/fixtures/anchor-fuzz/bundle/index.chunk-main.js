"use strict";var n=require("path"),a=require("fs"),s=require("child_process"),Tr={QUICK_ENTRY:"quick-entry"},X={info(){}};
function Uor(){switch(process.platform){case"darwin":return"/Library/Application Support/Claude/org-plugins";case"win32":return(0,n.join)("C:\\Program Files","Claude","org-plugins");default:return null}}
const xMt={mountPath:{mac:"/Library/Application Support/Claude/org-plugins",win:"C:\\org-plugins"}};
const fCr=process.arch==="arm64"?["/usr/share/AAVMF/AAVMF_CODE.fd"]:["/usr/share/OVMF/OVMF_CODE_4M.fd","/usr/share/OVMF/OVMF_CODE.fd"],pCr=["/usr/libexec/virtiofsd","/usr/bin/virtiofsd"],lCr=n.join(process.resourcesPath,"virtiofsd");async function vCr(e){for(const t of e)try{return await a.promises.access(t,a.constants.X_OK),t}catch{}return null}async function yCr(e,t){try{return await a.promises.access(e,t),e}catch{return null}}async function hCr(e){return await vCr(pCr)||(e?yCr(lCr,a.constants.X_OK):null)}
function Kyi(){return{status:"unsupported"}}function qyi(){return process.platform,Kyi()}
function UCr(){return"/tmp/cowork.sock"}function WCr(e){let t=(0,s.spawn)(e,["-socket",UCr()],{stdio:["pipe","pipe","pipe"]});return t}
let wY=null;async function mz(){}function hz(){return{status:"supported"}}async function XRa(e,t){return await mz(),hz().status==="supported"&&(e=!0),wY?(X.info("[downloadVM] Download already in progress, waiting..."),wY):(wY=Promise.resolve(t),wY)}
function trayIcon(e,t,i,o){switch(e){case"png":return t||i()==="gnome"||o.shouldUseDarkColors?"TrayIconLinux-Dark.png":"TrayIconLinux.png";default:return"TrayIcon.ico"}}
let PJ=null,ao=null;function po(){return!!ao&&ao.isFocused()}function Er(){}function zEr(){}
function Yqw(){PJ=new Object,Er(PJ.webContents,Tr.QUICK_ENTRY),zEr(PJ),PJ.setAlwaysOnTop(!0,"pop-up-menu")}
function JAa(){!PJ||PJ.isDestroyed()||PJ.hide()}
function kAa(e){X.info("[QuickEntry] Creating new chat with submit_quick_entry"),Promise.resolve(e).then(()=>{po()||ao.show()})}
function KAa(e){X.info("[QuickEntry] Creating new chat with submit_quick_entry"),Promise.resolve(e).then(()=>{po()||ao.show()})}
