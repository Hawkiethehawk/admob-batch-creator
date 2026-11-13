declare global {
  function GM_getValue<T>(key:string, fallback?:T):T;
  function GM_setValue(key:string, value:unknown):void;
  function GM_deleteValue(key:string):void;
  function GM_listValues():string[];
  function GM_addValueChangeListener(key:string, fn:(key:string,old:unknown,value:unknown,remote:boolean)=>void):number;
  function GM_removeValueChangeListener(id:number):void;
  function GM_openInTab(url:string, options?:{active?:boolean;insert?:boolean;setParent?:boolean}):{close():void;closed:boolean};
  function GM_setClipboard(text:string, type?:string):void;
  function GM_getTab(callback:(tab:Record<string,unknown>)=>void):void;
  function GM_saveTab(tab:Record<string,unknown>, callback?:()=>void):void;
}
export const PREFIX = 'abc:v1:';
export const uuid = () => crypto.randomUUID();
export const get = <T>(key:string, fallback:T):T => GM_getValue(PREFIX+key, fallback);
export function set(key:string, value:unknown):void {
  GM_setValue(PREFIX+key,value);
  if (JSON.stringify(GM_getValue(PREFIX+key)) !== JSON.stringify(value)) throw new Error('GM 存储回读不一致，已阻止继续');
}
export function listen(key:string, callback:()=>void):()=>void {
  const id = GM_addValueChangeListener(PREFIX+key,callback);
  return () => GM_removeValueChangeListener(id);
}
export async function tabState():Promise<Record<string,unknown>> {
  // GM_getTab is not exposed by every Tampermonkey build/sandbox. It is only
  // used to persist a tab id; the worker marker in the URL is authoritative,
  // so a missing or slow API must not abort the panel.
  if (typeof GM_getTab !== 'function') return {};
  return new Promise(resolve=>{
    let settled=false;
    const finish=(tab?:Record<string,unknown>)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(tab || {});};
    const timer=setTimeout(()=>finish({}),2000);
    try{GM_getTab(tab=>finish(tab));}catch{finish({});}
  });
}
export async function holdLock(name:string):Promise<()=>void> {
  if (!navigator.locks) throw new Error('当前环境不支持 Web Locks，无法保证主控互斥；已禁用创建');
  return new Promise((resolve,reject)=>{
    navigator.locks.request(name,{ifAvailable:true},lock=>{
      if (!lock) { reject(new Error('同一发布商账号已有活动主控；请在原主控继续或关闭原主控后恢复')); return; }
      return new Promise<void>(release=>resolve(release));
    }).catch(reject);
  });
}
export async function lockUnavailable(name:string):Promise<boolean> {
  if (!navigator.locks) return false;
  return navigator.locks.request(name,{ifAvailable:true},lock=>!lock);
}
export function download(name:string, text:string, mime='text/plain;charset=utf-8'):void {
  const url=URL.createObjectURL(new Blob([text],{type:mime}));
  const a=document.createElement('a');a.href=url;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),15000);
}
export function sameIdentity(a:{publisherId:string;appId:string},b:{publisherId:string;appId:string}):boolean {
  return a.publisherId===b.publisherId && a.appId===b.appId;
}
export async function waitFor<T>(read:()=>T|undefined, timeout=15000, watchKey?:string):Promise<T> {
  const current=read();if(current!==undefined)return current;
  return new Promise((resolve,reject)=>{
    let remove=()=>{},settled=false;
    const finish=()=>{settled=true;clearInterval(poll);clearTimeout(timer);remove();};
    const check=()=>{if(settled)return;try{const value=read();if(value!==undefined){finish();resolve(value);}}catch(e){finish();reject(e);}};
    const poll=setInterval(check,400);
    const timer=setTimeout(()=>{if(settled)return;finish();reject(new Error('跨页通信等待超时；不会自动重派原任务'));},timeout);
    // Polling remains as a recovery path for delayed/missing GM notifications.
    if(watchKey){
      try{remove=listen(watchKey,check);}catch{/* A missing listener retains the polling fallback. */}
      // Close the race between the first read and registering the listener.
      if(settled)remove();else check();
    }
  });
}
