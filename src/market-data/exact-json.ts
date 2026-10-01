/** Public JSON numeric tokens stay exact; this module cannot load account credentials. */
import { reject } from './model.js';
class NumericToken { constructor(readonly text: string) {Object.freeze(this);} }
export function numberText(value: unknown): string {
  if(typeof value==='string') return value;
  if(value instanceof NumericToken)return value.text;
  return reject('invalid-public-number');
}
export function record(value: unknown): Record<string, unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||value instanceof NumericToken)return reject();
  return value as Record<string,unknown>;
}
export function parsePublicJson(raw: Uint8Array): unknown {
  try {
    if(raw.byteLength>512*1024) return reject('public-response-too-large');
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);JSON.parse(text);
    let at=0,nodes=0;
    const ws=()=>{while(/[\x20\x09\x0a\x0d]/.test(text[at]??'\u0000'))at++;};
    const string=()=>{const start=at++;while(at<text.length){const c=text[at++];if(c==='\\')at++;else if(c==='"')return JSON.parse(text.slice(start,at)) as string;}return reject();};
    const value=(depth:number):unknown=>{
      if(depth>32||++nodes>20000)return reject();ws();
      if(text[at]==='"')return string();
      if(text[at]==='{'){
        at++;ws();const result:Record<string,unknown>=Object.create(null),keys=new Set<string>();
        if(text[at]==='}'){at++;return result;}
        while(true){ws();const key=string();if(keys.has(key))return reject();keys.add(key);ws();at++;result[key]=value(depth+1);ws();if(text[at++]==='}')return result;}
      }
      if(text[at]==='['){at++;ws();const result:unknown[]=[];if(text[at]===']'){at++;return result;}while(true){result.push(value(depth+1));ws();if(text[at++]===']')return result;}}
      for(const [literal,decoded] of [['true',true],['false',false],['null',null]] as const)if(text.startsWith(literal,at)){at+=literal.length;return decoded;}
      const n=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at));if(!n)return reject();at+=n[0].length;return new NumericToken(n[0]);
    };
    const result=value(0);ws();if(at!==text.length)return reject();return result;
  } catch {return reject('invalid-public-json');}
}
const SCALE=10n**30n;
export function decimal(value: unknown, signed=false, positive=false): string {
  const raw=numberText(value),match=/^(-?)(0|[1-9]\d{0,29})(?:\.(\d{1,30}))?(?:[eE]([+-]?\d{1,3}))?$/.exec(raw);
  if(!match||(!signed&&match[1]))return reject('invalid-public-number');
  const exp=Number(match[4]??0);if(Math.abs(exp)>60)return reject('invalid-public-number');
  let digits=match[2]+(match[3]??'');const point=match[2].length+exp;
  let out=point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
  let [whole,fraction='']=out.split('.');whole=whole.replace(/^0+(?=\d)/,'');fraction=fraction.replace(/0+$/,'');
  if(whole.length>30||fraction.length>30)return reject('invalid-public-number');
  out=whole+(fraction?'.'+fraction:'');if(positive&&!/[1-9]/.test(out))return reject('invalid-public-number');
  return match[1]&&/[1-9]/.test(out)?'-'+out:out;
}
export function units(value:string):bigint {const sign=value.startsWith('-')?-1n:1n;const [w,f='']=value.replace(/^-/,'').split('.');return sign*(BigInt(w)*SCALE+BigInt(f.padEnd(30,'0')));}
export function multiply(a:string,b:string):string {
  const product=units(decimal(a))*units(decimal(b));if(product%SCALE!==0n)return reject('public-product-precision');
  const n=product/SCALE,f=(n%SCALE).toString().padStart(30,'0').replace(/0+$/,'');return decimal(String(n/SCALE)+(f?'.'+f:''));
}
export function timestamp(value:unknown):number {
  const text=numberText(value);if(!/^[1-9]\d{0,15}$/.test(text))return reject('invalid-public-time');
  const n=Number(text);if(!Number.isSafeInteger(n)||n>8_640_000_000_000_000)return reject('invalid-public-time');return n;
}
