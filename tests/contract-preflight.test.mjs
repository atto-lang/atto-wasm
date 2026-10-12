import test from "node:test";
import assert from "node:assert/strict";
import {validateActorMessageV2Contract} from "../transport/messagepack-v2.mjs";

test("canonical actor contract grammar validates before handshake",()=>{
 for(const descriptor of ["T[S,I]","L[B]","FA[I,I,I]","B","T[]"]){
  assert.equal(validateActorMessageV2Contract({
   schemaId:"actor.Contract#variant=1",descriptor
  }),true);
 }
 for(const descriptor of ["T[S","T[Q]","L[]","T[S,I]]","T[S,,I]"]){
  assert.throws(()=>validateActorMessageV2Contract({
   schemaId:"actor.Contract#variant=1",descriptor
  }),/Oreslang MessagePack v2/);
 }
 assert.throws(()=>validateActorMessageV2Contract({
  schemaId:"invalid\nidentifier",descriptor:"T[S,I]"
 }),/invalid schema ID/);
});
