import test from "node:test";
import assert from "node:assert/strict";
import {encodeMessage,decodeMessage} from "../transport/owned-envelope.mjs";

const make=(type)=>({schemaVersion:1,ownership:"copy",variants:[
 {id:1,name:"Item",fields:[{name:"value",type}]}
]});
const msg={variant:"Item",fields:{value:0n}};

test("cyclic metadata never escapes bounded type normalization",async()=>{
 const loop={};
 loop.list={element:loop,maxLength:1};
 await assert.rejects(encodeMessage(make(loop),msg),/type nesting too deep/);
 await assert.rejects(decodeMessage(make(loop),new Uint8Array()),/type nesting too deep/);
});

test("sparse tuple metadata is never silently canonicalized",async()=>{
 const tuple=new Array(2);
 tuple[0]="i64";
 const schema=make({tuple});
 await assert.rejects(encodeMessage(schema,msg),/sparse tuple types/);
 await assert.rejects(decodeMessage(schema,new Uint8Array()),/sparse tuple types/);
});

test("nested accessor is rejected without invoking host getter",async()=>{
 let readCount=0;
 const list={maxLength:1};
 Object.defineProperty(list,"element",{enumerable:true,configurable:true,get(){
  readCount++;
  throw Error("attacker-controlled getter executed");
 }});
 await assert.rejects(encodeMessage(make({list}),msg),/invalid list shape/);
 assert.equal(readCount,0);
});
