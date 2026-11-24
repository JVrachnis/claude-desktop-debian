"use strict";const api={writeShellPty(e,n,r){return ipc.invoke("pty:write",e,n,r)}};const ipc={invoke(){}};module.exports=api;
