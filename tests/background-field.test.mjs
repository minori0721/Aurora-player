import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSpatialCover,sampleSpatialCover,meshPoint,createSpatialPainter,transitionProgress,mapCoverLightness,SPATIAL_TRANSITION_MS} from '../src/ui/background-field.js';
import { sameSpatialCover } from '../src/ui/background-field.js';

function fixture(color,width=96,height=96){return Uint8Array.from({length:width*height*4},(_,i)=>{const p=Math.floor(i/4),x=p%width,y=Math.floor(p/width);return color(x,y)[i%4];});}

test('same-cover detection requires exact spatial bytes, not a similar palette or malformed input', () => {
    const sample = sampleSpatialCover(fixture((x, y) => [x, y, 90, 255]), 96, 96);
    const copy = structuredClone(sample);
    assert.equal(sameSpatialCover(sample, copy), true);
    copy.data[900]++;
    assert.equal(sameSpatialCover(sample, copy), false);
    assert.equal(sameSpatialCover(null, null), false);
    assert.equal(sameSpatialCover(sample, { ...sample, width: 32 }), false);
    assert.equal(sameSpatialCover(sample, { ...sample, format: 'linear-rgba8' }), false);
    assert.equal(sameSpatialCover(sample, { ...sample, data: { length: 16384 } }), false);
});

test('small preblurred field is bounded, deterministic, neutral-safe and rejects invalid input',()=>{
    assert.equal(buildSpatialCover(new Uint8Array(4),96,96),null);
    for(const gray of [0,128,255]){
        const input=fixture(()=>[gray,gray,gray,255]),result=buildSpatialCover(input,96,96);
        assert.equal(result.data.byteLength,16384);assert.equal(result.width,64);assert.equal(result.height,64);
        for(let i=0;i<result.data.length;i+=4){assert.ok(Math.abs(result.data[i]-result.data[i+1])<=1);assert.ok(Math.abs(result.data[i+1]-result.data[i+2])<=1);assert.equal(result.data[i+3],255);}
        assert.deepEqual(buildSpatialCover(input,96,96),result);
    }
    const transparent=buildSpatialCover(fixture(()=>[0,0,0,0]),96,96);
    assert.ok(transparent.data[0]>200);
});

test('cover quadrants retain their own locations and transparency cannot inject black',()=>{
    const input=fixture((x,y)=>y<48?(x<48?[220,45,45,255]:[40,150,45,255]):(x<48?[40,70,200,255]:[230,185,40,255]));
    const field=buildSpatialCover(input,96,96).data;
    const at=(x,y)=>[...field.slice((y*64+x)*4,(y*64+x)*4+3)];
    const red=at(8,8),green=at(55,8),blue=at(8,55),yellow=at(55,55);
    assert.ok(red[0]>red[1]&&red[0]>red[2]);assert.ok(green[1]>green[0]&&green[1]>green[2]);
    assert.ok(blue[2]>blue[0]&&blue[2]>blue[1]);assert.ok(yellow[0]>yellow[2]&&yellow[1]>yellow[2]);
    const opaque=buildSpatialCover(fixture(()=>[40,70,200,255]),96,96).data;
    const border=buildSpatialCover(fixture((x,y)=>x<10||y<10?[0,0,0,0]:[40,70,200,255]),96,96).data;
    assert.deepEqual([...border.slice(0,3)],[...opaque.slice(0,3)]);
});

test('three radius-3.5 blur passes keep color transitions local on the 64-pixel field', () => {
    const blue = [40, 70, 200, 255], red = [220, 45, 45, 255];
    const data = buildSpatialCover(fixture(x => x < 32 ? blue : red, 64, 64), 64, 64).data;
    const solid = color => [...buildSpatialCover(fixture(() => color, 64, 64), 64, 64).data.slice(0, 3)];
    const at = x => [...data.slice((32 * 64 + x) * 4, (32 * 64 + x) * 4 + 3)];
    assert.deepEqual(at(19), solid(blue));
    assert.deepEqual(at(44), solid(red));
    assert.notDeepEqual(at(22), solid(blue));
    assert.notDeepEqual(at(28), solid(blue));
    assert.notDeepEqual(at(35), solid(red));
});

test('fractional blur matches half-weight outer samples instead of rounding the radius', () => {
    const data = buildSpatialCover(fixture(x => x < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255], 64, 64), 64, 64).data;
    const reference = weights => {
        let row = Array.from({ length: 64 }, (_, x) => x < 32 ? 0 : 1);
        const extent = (weights.length - 1) / 2, total = weights.reduce((sum, weight) => sum + weight, 0);
        for (let pass = 0; pass < 3; pass++) {
            row = row.map((_, x) => weights.reduce((sum, weight, index) =>
                sum + weight * row[Math.max(0, Math.min(63, x + index - extent))], 0) / total);
        }
        return row.map(value => Math.round(mapCoverLightness(Math.cbrt(value)) ** 3 * 255));
    };
    const expected = reference([.5, 1, 1, 1, 1, 1, 1, 1, .5]);
    assert.notDeepEqual(expected, reference(Array(7).fill(1)));
    assert.notDeepEqual(expected, reference(Array(9).fill(1)));
    for (let x = 0; x < 64; x++) {
        const offset = (32 * 64 + x) * 4;
        for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(data[offset + channel] - expected[x]) <= 1);
        assert.equal(data[offset + 3], 255);
    }
});

test('deforming grid stays bounded with fixed edges and no folded triangles',()=>{
    const cells=12,area=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    for(let time=0;time<Math.PI*200;time+=.2){
        for(let y=0;y<=cells;y++)for(let x=0;x<=cells;x++){
            const p=meshPoint(x/cells,y/cells,time);assert.ok(p.every(v=>v>=-1e-10&&v<=1+1e-10));
            if(x===0||y===0||x===cells||y===cells){assert.ok(Math.abs(p[0]-x/cells)<1e-10);assert.ok(Math.abs(p[1]-y/cells)<1e-10);}
            if(x<cells&&y<cells){const a=p,b=meshPoint((x+1)/cells,y/cells,time),c=meshPoint(x/cells,(y+1)/cells,time),d=meshPoint((x+1)/cells,(y+1)/cells,time);assert.ok(area(a,b,c)>0);assert.ok(area(b,d,c)>0);}
        }
    }
});

test('unsupported WebGL retains the static fallback',()=>assert.equal(createSpatialPainter({getContext:()=>null}),null));

test('neutral lightness curve keeps requested anchors, monotonicity and continuous slopes',()=>{
    const linear=value=>{const x=value/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;};
    const input=value=>Math.cbrt(linear(value));
    const output=value=>255*(value**3<=.0031308?12.92*value**3:1.055*(value**3)**(1/2.4)-.055);
    for(const [gray,expected]of [[0,175],[64,182],[128,200],[192,220],[255,230]])assert.ok(Math.abs(output(mapCoverLightness(input(gray)))-expected)<1e-7);
    let prior=-Infinity;
    for(let i=0;i<=10000;i++){const value=mapCoverLightness(i/10000);assert.ok(value>=prior-1e-12);assert.ok(output(value)>=175-1e-7&&output(value)<=230+1e-7);prior=value;}
    for(const gray of [64,128,192]){const x=input(gray),h=1e-6,center=mapCoverLightness(x);const left=(center-mapCoverLightness(x-h))/h,right=(mapCoverLightness(x+h)-center)/h;assert.ok(Math.abs(left-right)<1e-4);}
    assert.equal(mapCoverLightness(-1),mapCoverLightness(0));assert.equal(mapCoverLightness(2),mapCoverLightness(1));
});

test('color transition is bounded, monotone and eases velocity and acceleration at both ends',()=>{
    assert.equal(SPATIAL_TRANSITION_MS,1000);
    assert.equal(transitionProgress(-100),0);assert.equal(transitionProgress(0),0);
    assert.equal(transitionProgress(500),.5);assert.equal(transitionProgress(1000),1);
    assert.equal(transitionProgress(Infinity),1);
    let previous=0;
    for(let t=0;t<=1000;t++) { const value=transitionProgress(t);assert.ok(value>=previous-1e-12&&value>=0&&value<=1);previous=value; }
    const first=transitionProgress(1),last=1-transitionProgress(999);
    assert.ok(first<1e-7&&last<1e-7);
    assert.ok(Math.abs(transitionProgress(2)-2*first)<3e-7);
});

test('main-thread sampling copies only 16KiB and leaves blur for the Worker',()=>{
    const source=fixture((x,y)=>[x,y,90,255]);
    const result=sampleSpatialCover(source,96,96);assert.equal(result.data.byteLength,16384);assert.equal(result.format,'srgb-rgba8');
    source.fill(0);assert.equal(result.data[2],90);assert.equal(result.data.at(-1),255);
});

test('only two textures are allocated; rapid changes blend from the visible image and do not upload per frame',()=>{
    const constants=new Map(),uploaded=[],deleted=[];let seed=1,slot=0,images=0,subImages=0,draws=0,now=0;
    const gl=new Proxy({createShader:()=>({}),shaderSource(){},compileShader(){},getShaderParameter:()=>true,
        createProgram:()=>({}),attachShader(){},linkProgram(){},getProgramParameter:()=>true,useProgram(){},
        createBuffer:()=>({}),bindBuffer(){},bufferData(){},getAttribLocation:()=>0,enableVertexAttribArray(){},vertexAttribPointer(){},
        getUniformLocation:(_,name)=>name,createTexture:()=>({}),activeTexture(value){slot=value-gl.TEXTURE0;},bindTexture(){},texParameteri(){},
        texImage2D(){images++;},texSubImage2D(...args){subImages++;uploaded[slot]=new Uint8Array(args.at(-1));},uniform1i(){},uniform1f(){},viewport(){},drawElements(){draws++;},
        deleteBuffer:()=>deleted.push('buffer'),deleteTexture:()=>deleted.push('texture'),deleteShader:()=>deleted.push('shader'),deleteProgram:()=>deleted.push('program')
    },{get(target,name){if(name in target)return target[name];if(!constants.has(name))constants.set(name,seed++);return constants.get(name);}});
    const painter=createSpatialPainter({getContext:()=>gl,width:512,height:320});assert.ok(painter);assert.equal(images,2);
    const cover=value=>{const data=new Uint8Array(16384).fill(value);for(let i=3;i<data.length;i+=4)data[i]=255;return{spatial:{width:64,height:64,data,format:'linear-rgba8'}};};
    const original=performance.now;performance.now=()=>now;
    try{
        painter.setTheme(cover(100),0);now=100;painter.setTheme(cover(200),100);
        now=600;painter.setTheme(cover(50),600);assert.equal(uploaded[0][0],150);assert.equal(uploaded[1][0],50);
        for(let i=0;i<100;i++)painter.draw(null,null,i/30);
        assert.equal(images,2);assert.equal(subImages,6);assert.equal(draws,100);
        assert.equal(painter.getStats().rawTextureBytes,32768);
        painter.finishTransition();painter.dispose();painter.setTheme(cover(80));assert.equal(subImages,6);
        assert.equal(deleted.filter(name=>name==='texture').length,2);assert.equal(deleted.filter(name=>name==='buffer').length,2);assert.equal(deleted.filter(name=>name==='shader').length,2);
    }finally{performance.now=original;}
});
