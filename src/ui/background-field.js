export const SPATIAL_SIZE = 64;
export const SPATIAL_TRANSITION_MS = 1000;
const CELLS = 12;
const linear = Float64Array.from({ length: 256 }, (_, value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const toneInputs = [0, 64, 128, 192, 255].map(value => Math.cbrt(linear[value]));
const toneOutputs = [175, 182, 200, 220, 230].map(value => Math.cbrt(linear[value]));
const toneDeltas = toneInputs.slice(1).map((value, index) =>
    (toneOutputs[index + 1] - toneOutputs[index]) / (value - toneInputs[index]));
const toneSlopes = [0, ...toneDeltas.slice(1).map((value, index) => (toneDeltas[index] + value) / 2), 0];
for (let index = 0; index < toneDeltas.length; index++) {
    const a = toneSlopes[index] / toneDeltas[index], b = toneSlopes[index + 1] / toneDeltas[index];
    const norm = Math.hypot(a, b);
    if (norm > 3) {
        const scale = 3 / norm;
        toneSlopes[index] *= scale;
        toneSlopes[index + 1] *= scale;
    }
}

// Limit Hermite tangents so the neutral-gray anchors cannot overshoot.
export function mapCoverLightness(light) {
    const x = clamp(Number.isFinite(light) ? light : 0);
    let index = 0;
    while (index < toneInputs.length - 2 && x > toneInputs[index + 1]) index++;
    const width = toneInputs[index + 1] - toneInputs[index], t = (x - toneInputs[index]) / width;
    const t2 = t * t, t3 = t2 * t;
    return clamp((2 * t3 - 3 * t2 + 1) * toneOutputs[index] + (t3 - 2 * t2 + t) * width * toneSlopes[index]
        + (-2 * t3 + 3 * t2) * toneOutputs[index + 1] + (t3 - t2) * width * toneSlopes[index + 1],
    toneOutputs[0], toneOutputs.at(-1));
}

function tone(r, g, b, output, offset) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const light = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    let a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    let bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const chroma = Math.hypot(a, bb), scale = chroma ? Math.min(0.7, 0.095 / chroma) : 0;
    a *= scale;
    bb *= scale;
    const L = mapCoverLightness(light);
    const rgb = amount => {
        const ll = (L + 0.3963377774 * a * amount + 0.2158037573 * bb * amount) ** 3;
        const mm = (L - 0.1055613458 * a * amount - 0.0638541728 * bb * amount) ** 3;
        const ss = (L - 0.0894841775 * a * amount - 1.291485548 * bb * amount) ** 3;
        return [4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
            -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
            -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss];
    };
    let values = rgb(1);
    if (values.some(c => c < 0 || c > 1)) {
        let low = 0, high = 1;
        for (let i = 0; i < 9; i++) {
            const mid = (low + high) / 2;
            if (rgb(mid).every(c => c >= 0 && c <= 1)) low = mid;
            else high = mid;
        }
        values = rgb(low);
    }
    for (let i = 0; i < 3; i++) output[offset + i] = Math.round(clamp(values[i]) * 255);
    output[offset + 3] = 255;
}

export function sampleSpatialCover(pixels, width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
        || !pixels || pixels.length !== width * height * 4) return null;
    const data = new Uint8Array(SPATIAL_SIZE * SPATIAL_SIZE * 4);
    for (let y = 0; y < SPATIAL_SIZE; y++) for (let x = 0; x < SPATIAL_SIZE; x++) {
        const source = (Math.min(height - 1, Math.floor((y + .5) * height / SPATIAL_SIZE)) * width
            + Math.min(width - 1, Math.floor((x + .5) * width / SPATIAL_SIZE))) * 4;
        data.set(pixels.subarray(source, source + 4), (y * SPATIAL_SIZE + x) * 4);
    }
    return { width: SPATIAL_SIZE, height: SPATIAL_SIZE, data, format: 'srgb-rgba8' };
}

export function sameSpatialCover(one, other) {
    if (!one || !other || one.width !== SPATIAL_SIZE || one.height !== SPATIAL_SIZE
        || other.width !== one.width || other.height !== one.height || one.format !== 'srgb-rgba8'
        || other.format !== one.format || !(one.data instanceof Uint8Array) || !(other.data instanceof Uint8Array)
        || one.data.length !== SPATIAL_SIZE * SPATIAL_SIZE * 4
        || other.data?.length !== one.data.length) return false;
    return one === other || one.data === other.data || one.data.every((value, index) => value === other.data[index]);
}

export function buildSpatialCover(pixels, width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
        || !pixels || pixels.length !== width * height * 4) return null;
    let field = new Float32Array(SPATIAL_SIZE * SPATIAL_SIZE * 4), scratch = new Float32Array(field.length);
    for (let y = 0; y < SPATIAL_SIZE; y++) for (let x = 0; x < SPATIAL_SIZE; x++) {
        const source = (Math.min(height - 1, Math.floor((y + .5) * height / SPATIAL_SIZE)) * width
            + Math.min(width - 1, Math.floor((x + .5) * width / SPATIAL_SIZE))) * 4;
        const alpha = pixels[source + 3] / 255;
        const r = linear[pixels[source]], g = linear[pixels[source + 1]], b = linear[pixels[source + 2]];
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        const weight = alpha * (0.12 + 0.88 * clamp(chroma / 0.12));
        const offset = (y * SPATIAL_SIZE + x) * 4;
        field[offset] = r * weight;
        field[offset + 1] = g * weight;
        field[offset + 2] = b * weight;
        field[offset + 3] = weight;
    }
    // Three separable box passes approximate a broad blur once per cover, in the Worker.
    const radius = 4;
    for (let pass = 0; pass < 3; pass++) for (let axis = 0; axis < 2; axis++) {
        for (let y = 0; y < SPATIAL_SIZE; y++) for (let x = 0; x < SPATIAL_SIZE; x++) for (let c = 0; c < 4; c++) {
            let sum = 0;
            for (let d = -radius; d <= radius; d++) {
                const xx = axis === 0 ? clamp(x + d, 0, SPATIAL_SIZE - 1) : x;
                const yy = axis === 1 ? clamp(y + d, 0, SPATIAL_SIZE - 1) : y;
                sum += field[(yy * SPATIAL_SIZE + xx) * 4 + c];
            }
            scratch[(y * SPATIAL_SIZE + x) * 4 + c] = sum / (radius * 2 + 1);
        }
        [field, scratch] = [scratch, field];
    }
    const data = new Uint8Array(field.length);
    for (let offset = 0; offset < data.length; offset += 4) {
        const weight = field[offset + 3];
        if (weight > 1e-6) tone(field[offset] / weight, field[offset + 1] / weight, field[offset + 2] / weight, data, offset);
        else tone(1, 1, 1, data, offset);
    }
    return { width: SPATIAL_SIZE, height: SPATIAL_SIZE, data, format: 'linear-rgba8' };
}

export function meshPoint(x, y, time) {
    const edge = Math.sin(Math.PI * x) * Math.sin(Math.PI * y);
    return [x + 0.115 * edge * (Math.sin(time * .65 + y * 2.4) + .25 * Math.sin(time * .93 + x * 1.8)),
        y + 0.115 * edge * (Math.cos(time * .57 + x * 2.6) + .25 * Math.sin(time * .81 + y * 1.8))];
}

export function transitionProgress(elapsedMs) {
    const t = clamp(elapsedMs / SPATIAL_TRANSITION_MS);
    return t * t * t * (t * (t * 6 - 15) + 10);
}

function fallbackCover(theme) {
    const values = String(theme?.base || 'rgb(245,247,250)').match(/[\d.]+/g)?.slice(0, 3).map(Number);
    const rgb = values?.length === 3 ? values : [245, 247, 250];
    const data = new Uint8Array(SPATIAL_SIZE * SPATIAL_SIZE * 4);
    for (let offset = 0; offset < data.length; offset += 4) {
        for (let c = 0; c < 3; c++) data[offset + c] = Math.round(linear[Math.round(clamp(rgb[c], 0, 255))] * 255);
        data[offset + 3] = 255;
    }
    return { width: SPATIAL_SIZE, height: SPATIAL_SIZE, data };
}

export function createSpatialPainter(canvas) {
    const gl = canvas?.getContext('webgl', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
    if (!gl || typeof gl.createShader !== 'function') return null;
    const shaders = [], textures = [], buffers = [];
    let program = null, from = null, target = null, changedAt = -Infinity, uploads = 0;
    const dispose = () => {
        buffers.forEach(buffer => gl.deleteBuffer(buffer));
        textures.forEach(texture => gl.deleteTexture(texture));
        shaders.forEach(shader => gl.deleteShader(shader));
        if (program) gl.deleteProgram(program);
        program = null;
        from = target = null;
    };
    try {
        const compile = (type, source) => {
            const shader = gl.createShader(type);
            if (!shader) throw new Error('Background shader unavailable');
            shaders.push(shader);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Background shader compilation failed');
            return shader;
        };
        const vertex = compile(gl.VERTEX_SHADER, `attribute vec2 position; varying vec2 uv; uniform float time;
            void main(){uv=position;float edge=sin(3.14159265*position.x)*sin(3.14159265*position.y);
            vec2 shift=vec2(sin(time*.65+position.y*2.4)+.25*sin(time*.93+position.x*1.8),cos(time*.57+position.x*2.6)+.25*sin(time*.81+position.y*1.8));
            vec2 p=position+.115*edge*shift;gl_Position=vec4(p.x*2.-1.,1.-p.y*2.,0.,1.);}`);
        const fragment = compile(gl.FRAGMENT_SHADER, `#ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            varying vec2 uv;uniform sampler2D previous;uniform sampler2D current;uniform float progress;
            void main(){vec3 color=mix(texture2D(previous,uv).rgb,texture2D(current,uv).rgb,progress);
            color=clamp(color,0.,1.);
            vec3 srgb=mix(color*12.92,1.055*pow(color,vec3(1./2.4))-.055,step(vec3(.0031308),color));
            float noise=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))))-.5;
            gl_FragColor=vec4(clamp(srgb+noise/255.,0.,1.),1.);}`);
        program = gl.createProgram();
        if (!program) throw new Error('Background program unavailable');
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Background link failed');
        gl.useProgram(program);
        const vertices = [], indices = [];
        for (let y = 0; y <= CELLS; y++) for (let x = 0; x <= CELLS; x++) vertices.push(x / CELLS, y / CELLS);
        for (let y = 0; y < CELLS; y++) for (let x = 0; x < CELLS; x++) {
            const a = y * (CELLS + 1) + x, b = a + 1, c = a + CELLS + 1, d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
        for (let i = 0; i < 2; i++) {
            const buffer = gl.createBuffer();
            if (!buffer) throw new Error('Background buffer unavailable');
            buffers.push(buffer);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers[0]);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers[1]);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, 'position');
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        const timeLocation = gl.getUniformLocation(program, 'time'), progressLocation = gl.getUniformLocation(program, 'progress');
        for (let i = 0; i < 2; i++) {
            const texture = gl.createTexture();
            if (!texture) throw new Error('Background texture unavailable');
            textures.push(texture);
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SPATIAL_SIZE, SPATIAL_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        gl.uniform1i(gl.getUniformLocation(program, 'previous'), 0);
        gl.uniform1i(gl.getUniformLocation(program, 'current'), 1);
        const amount = now => transitionProgress(now - changedAt);
        const upload = (slot, data) => {
            gl.activeTexture(gl.TEXTURE0 + slot);
            gl.bindTexture(gl.TEXTURE_2D, textures[slot]);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPATIAL_SIZE, SPATIAL_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, data);
            uploads++;
        };
        return {
            setTheme(theme, now = performance.now()) {
                if (!program) return;
                const input = theme?.spatial?.width === SPATIAL_SIZE && theme.spatial.height === SPATIAL_SIZE
                    && theme.spatial.data?.length === SPATIAL_SIZE * SPATIAL_SIZE * 4 ? theme.spatial : null;
                const cover = input ? (input.format === 'srgb-rgba8' ? buildSpatialCover(input.data, SPATIAL_SIZE, SPATIAL_SIZE) : input) : fallbackCover(theme);
                const next = new Uint8Array(cover.data);
                if (target && next.every((value, index) => value === target[index])) return;
                if (target) {
                    const mix = amount(now), blended = new Uint8Array(target.length);
                    for (let i = 0; i < blended.length; i++) blended[i] = Math.round(from[i] + (target[i] - from[i]) * mix);
                    from = blended;
                    changedAt = now;
                } else {
                    from = next;
                    changedAt = -Infinity;
                }
                target = next;
                upload(0, from);
                upload(1, target);
            },
            draw(_colors, _weights, phase) {
                if (!program) return;
                if (!target) this.setTheme({});
                gl.viewport(0, 0, canvas.width, canvas.height);
                gl.useProgram(program);
                gl.uniform1f(timeLocation, phase);
                gl.uniform1f(progressLocation, amount(performance.now()));
                gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
            },
            dispose,
            finishTransition() { changedAt = -Infinity; },
            getStats: () => ({ uploads, textures: textures.length, rawTextureBytes: SPATIAL_SIZE * SPATIAL_SIZE * 4 * 2 })
        };
    } catch (_) { dispose(); return null; }
}
