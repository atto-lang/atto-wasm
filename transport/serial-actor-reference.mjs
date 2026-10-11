/**
 * Experimental host-side reference protocol for a serial actor delivery.
 * This is NOT Oreslang guest ABI lowering, or a replacement for an isolated
 * Worker/supervisor.  It uses the exact owned-message v1 wire codec.
 *
 * Returning a value from receive() NEVER responds. The receiver must use
 * self.respond() or self.forward(), and explicitly self.done() to release
 * its one active delivery lane.
 */
import {encodeMessage,decodeMessage} from "./owned-envelope.mjs";

const fail=reason=>{throw new TypeError("Oreslang serial mailbox: "+reason)};
export function createSerialOwnedActor({
 schema,receive,maxPending=64,maxBytes=1048576,routeSend,routeForward
}={}){
 if(typeof receive!=="function")fail("receive callback required");
 if(!Number.isSafeInteger(maxPending)||maxPending<1||maxPending>4096)
  fail("invalid maxPending");
 if(!Number.isSafeInteger(maxBytes)||maxBytes<44||maxBytes>1048576)
  fail("invalid maxBytes");
 if(routeSend!==undefined&&typeof routeSend!=="function")fail("invalid send route");
 if(routeForward!==undefined&&typeof routeForward!=="function")fail("invalid forward route");

 const queue=[];
 let running=false,closed=false,active=0;
 const pump=()=>{
  if(running||queue.length===0)return;
  running=true;active=1;
  const item=queue.shift();
  Promise.resolve().then(async()=>{
   const raw=await item.encoded;
   const mail=await decodeMessage(schema,raw,{maxBytes});
   let done=false,finished=false,disposition=null,response,forwarded;
   const outbox=[];
   const open=()=>{
    if(done||finished)fail("delivery already completed");
    if(closed)fail("actor closed");
   };
   const claim=what=>{
    open();
    if(disposition!==null)fail("reply or forward already claimed");
    disposition=what;
   };
   const self=Object.freeze({
    respond(message){
     claim("respond");
     response=encodeMessage(schema,message,{maxBytes});
     response.catch(()=>{});
     return response.then(()=>undefined);
    },
    forward(target,message){
     open();
     if(!routeForward)fail("forward route unavailable");
     claim("forward");
     // The host route accepts *owned encoded bytes* and returns the final
     // response as an owned encoded envelope, not a borrowed guest pointer.
     const encoded=encodeMessage(schema,message,{maxBytes});
     forwarded=encoded.then(bytes=>routeForward(target,Uint8Array.from(bytes)));
     forwarded.catch(()=>{});
     return forwarded.then(()=>undefined);
    },
    send(target,message){
     open();
     if(!routeSend)fail("send route unavailable");
     if(outbox.length>=64)fail("delivery outbound send budget exceeded");
     // Sending another message does not own or finish the current reply.
     const encoded=encodeMessage(schema,message,{maxBytes});
     const sent=encoded.then(bytes=>routeSend(target,Uint8Array.from(bytes)));
     sent.catch(()=>{});
     outbox.push(sent);
     return sent.then(()=>undefined);
    },
    done(){
     open();
     done=true;
    }
   });
   // Intentionally ignore receive's returned VALUE. Await only its
   // completion. A value-returning match cannot implicitly emit a reply.
   try{await receive(mail,self);}finally{finished=true;}
   if(!done)fail("receive handler must call self.done()");
   await Promise.all(outbox);
   if(item.request){
    if(disposition===null)fail("request completed without respond or forward");
    const replyBytes=await(disposition==="respond"?response:forwarded);
    return decodeMessage(schema,replyBytes,{maxBytes});
   }
   if(disposition!==null)fail("one-way message cannot claim a reply");
   return undefined;
  }).then(item.resolve,item.reject).finally(()=>{
   active=0;running=false;
   // Only a completed handler releases the serial execution lane.
   queueMicrotask(pump);
  });
 };
 const submit=(message,request)=>{
  if(closed)return Promise.reject(new Error("actor closed"));
  if(queue.length+active>=maxPending)
   return Promise.reject(new Error("actor mailbox capacity exceeded"));
  // encodeMessage copies typed input before its first await, so callers
  // cannot mutate a queued delivery or overtake the single-flight order.
  const encoded=encodeMessage(schema,message,{maxBytes});
  encoded.catch(()=>{});
  return new Promise((resolve,reject)=>{
   queue.push({encoded,request,resolve,reject});
   pump();
  });
 };
 return Object.freeze({
  request(message){return submit(message,true)},
  tell(message){return submit(message,false)},
  close(){
   if(closed)return;
   closed=true;
   for(const item of queue.splice(0))
    item.reject(new Error("actor closed"));
  },
  get pending(){return queue.length+active},
  get idle(){return !running&&queue.length===0}
 });
}
