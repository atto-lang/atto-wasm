import test from "node:test";
import assert from "node:assert/strict";

test("decoder-owned MessagePack snapshots are scrubbed on success and failure",async()=>{
  const originalFill=Uint8Array.prototype.fill;
  const scrubbed=[];
  const originalArrayFill=Array.prototype.fill;
  const scrubbedWriterArrays=[];
  Array.prototype.fill=function(value,...rest){
    if(value===0 && this.length>44) scrubbedWriterArrays.push(this);
    return Reflect.apply(originalArrayFill,this,[value,...rest]);
  };
  // Import a fresh module while the spy is installed. The implementation
  // captures the native fill at module initialization to avoid later changes.
  Uint8Array.prototype.fill=function(value,...rest){
    if(value===0 && this.length>44) scrubbed.push(this);
    return Reflect.apply(originalFill,this,[value,...rest]);
  };
  try{
    const codec=await import("../transport/messagepack-v2.mjs?frame-wipe-contract-v1");
    const collection="audit.PrivateCollection.v1";
    const shape="S";
    const frame=await codec.encodeCollectionV2(collection,shape,"private payload");
    const untouched=Uint8Array.from(frame);
    let before=scrubbed.length;
    let writerBefore=scrubbedWriterArrays.length;
    assert.equal(await codec.decodeCollectionV2(collection,shape,frame),"private payload");
    assert.ok(scrubbed.slice(before).some(b=>b.length===frame.length && b.every(v=>v===0)),
      "successful collection decoding must scrub its owned snapshot");
    assert.ok(scrubbed.slice(before).filter(b=>b.length===frame.length && b.every(v=>v===0)).length>=2,
      "both the decoded frame and canonical re-encoding must be scrubbed");
    assert.ok(scrubbedWriterArrays.slice(writerBefore).some(b=>b.length===frame.length && b.every(v=>v===0)),
      "canonical MessagePack writer arrays must be zeroed");
    assert.deepEqual(frame,untouched,"decoder must not wipe caller bytes");

    before=scrubbed.length;
    await assert.rejects(codec.decodeCollectionV2(collection,"T[S]",frame),/shape digest mismatch/);
    assert.ok(scrubbed.slice(before).some(b=>b.length===frame.length && b.every(v=>v===0)),
      "asynchronous digest mismatch must also scrub its detached frame");
    assert.deepEqual(frame,untouched,"failed digest must preserve caller bytes");

    const malformed=Uint8Array.from(frame);
    malformed[0]=0;
    before=scrubbed.length;
    await assert.rejects(codec.decodeCollectionV2(collection,shape,malformed));
    assert.ok(scrubbed.slice(before).some(b=>b.length===malformed.length && b.every(v=>v===0)),
      "failed collection decoding must scrub its owned snapshot");

    const domain="audit.PrivateActor.v1",alternatives=[{id:1,shape:"S"}];
    const actor=await codec.encodeActorMessage(domain,alternatives,1,"secret");
    before=scrubbed.length;
    const decoded=await codec.decodeActorMessage(domain,alternatives,actor);
    assert.equal(decoded.value,"secret");
    assert.ok(scrubbed.slice(before).some(b=>b.length===actor.length && b.every(v=>v===0)),
      "successful actor decoding must scrub its owned snapshot");

    const forged=Uint8Array.from(actor);
    forged[0]=0;
    before=scrubbed.length;
    await assert.rejects(codec.decodeActorMessage(domain,alternatives,forged));
    assert.ok(scrubbed.slice(before).some(b=>b.length===forged.length && b.every(v=>v===0)),
      "failed actor decoding must scrub its owned snapshot");
  }finally{
    Uint8Array.prototype.fill=originalFill;
    Array.prototype.fill=originalArrayFill;
  }
});
