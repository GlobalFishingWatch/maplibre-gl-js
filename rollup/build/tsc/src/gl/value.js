import Color from '../style-spec/util/color';
class BaseValue {
    constructor(context) {
        this.gl = context.gl;
        this.default = this.getDefault();
        this.current = this.default;
        this.dirty = false;
    }
    get() {
        return this.current;
    }
    set(value) {
        // overridden in child classes;
    }
    getDefault() {
        return this.default; // overriden in child classes
    }
    setDefault() {
        this.set(this.default);
    }
}
export class ClearColor extends BaseValue {
    getDefault() {
        return Color.transparent;
    }
    set(v) {
        const c = this.current;
        if (v.r === c.r && v.g === c.g && v.b === c.b && v.a === c.a && !this.dirty)
            return;
        this.gl.clearColor(v.r, v.g, v.b, v.a);
        this.current = v;
        this.dirty = false;
    }
}
export class ClearDepth extends BaseValue {
    getDefault() {
        return 1;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.gl.clearDepth(v);
        this.current = v;
        this.dirty = false;
    }
}
export class ClearStencil extends BaseValue {
    getDefault() {
        return 0;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.gl.clearStencil(v);
        this.current = v;
        this.dirty = false;
    }
}
export class ColorMask extends BaseValue {
    getDefault() {
        return [true, true, true, true];
    }
    set(v) {
        const c = this.current;
        if (v[0] === c[0] && v[1] === c[1] && v[2] === c[2] && v[3] === c[3] && !this.dirty)
            return;
        this.gl.colorMask(v[0], v[1], v[2], v[3]);
        this.current = v;
        this.dirty = false;
    }
}
export class DepthMask extends BaseValue {
    getDefault() {
        return true;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.gl.depthMask(v);
        this.current = v;
        this.dirty = false;
    }
}
export class StencilMask extends BaseValue {
    getDefault() {
        return 0xFF;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.gl.stencilMask(v);
        this.current = v;
        this.dirty = false;
    }
}
export class StencilFunc extends BaseValue {
    getDefault() {
        return {
            func: this.gl.ALWAYS,
            ref: 0,
            mask: 0xFF
        };
    }
    set(v) {
        const c = this.current;
        if (v.func === c.func && v.ref === c.ref && v.mask === c.mask && !this.dirty)
            return;
        this.gl.stencilFunc(v.func, v.ref, v.mask);
        this.current = v;
        this.dirty = false;
    }
}
export class StencilOp extends BaseValue {
    getDefault() {
        const gl = this.gl;
        return [gl.KEEP, gl.KEEP, gl.KEEP];
    }
    set(v) {
        const c = this.current;
        if (v[0] === c[0] && v[1] === c[1] && v[2] === c[2] && !this.dirty)
            return;
        this.gl.stencilOp(v[0], v[1], v[2]);
        this.current = v;
        this.dirty = false;
    }
}
export class StencilTest extends BaseValue {
    getDefault() {
        return false;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        const gl = this.gl;
        if (v) {
            gl.enable(gl.STENCIL_TEST);
        }
        else {
            gl.disable(gl.STENCIL_TEST);
        }
        this.current = v;
        this.dirty = false;
    }
}
export class DepthRange extends BaseValue {
    getDefault() {
        return [0, 1];
    }
    set(v) {
        const c = this.current;
        if (v[0] === c[0] && v[1] === c[1] && !this.dirty)
            return;
        this.gl.depthRange(v[0], v[1]);
        this.current = v;
        this.dirty = false;
    }
}
export class DepthTest extends BaseValue {
    getDefault() {
        return false;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        const gl = this.gl;
        if (v) {
            gl.enable(gl.DEPTH_TEST);
        }
        else {
            gl.disable(gl.DEPTH_TEST);
        }
        this.current = v;
        this.dirty = false;
    }
}
export class DepthFunc extends BaseValue {
    getDefault() {
        return this.gl.LESS;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.gl.depthFunc(v);
        this.current = v;
        this.dirty = false;
    }
}
export class Blend extends BaseValue {
    getDefault() {
        return false;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        const gl = this.gl;
        if (v) {
            gl.enable(gl.BLEND);
        }
        else {
            gl.disable(gl.BLEND);
        }
        this.current = v;
        this.dirty = false;
    }
}
export class BlendFunc extends BaseValue {
    getDefault() {
        const gl = this.gl;
        return [gl.ONE, gl.ZERO];
    }
    set(v) {
        const c = this.current;
        if (v[0] === c[0] && v[1] === c[1] && !this.dirty)
            return;
        this.gl.blendFunc(v[0], v[1]);
        this.current = v;
        this.dirty = false;
    }
}
export class BlendColor extends BaseValue {
    getDefault() {
        return Color.transparent;
    }
    set(v) {
        const c = this.current;
        if (v.r === c.r && v.g === c.g && v.b === c.b && v.a === c.a && !this.dirty)
            return;
        this.gl.blendColor(v.r, v.g, v.b, v.a);
        this.current = v;
        this.dirty = false;
    }
}
export class BlendEquation extends BaseValue {
    getDefault() {
        return this.gl.FUNC_ADD;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.gl.blendEquation(v);
        this.current = v;
        this.dirty = false;
    }
}
export class CullFace extends BaseValue {
    getDefault() {
        return false;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        const gl = this.gl;
        if (v) {
            gl.enable(gl.CULL_FACE);
        }
        else {
            gl.disable(gl.CULL_FACE);
        }
        this.current = v;
        this.dirty = false;
    }
}
export class CullFaceSide extends BaseValue {
    getDefault() {
        return this.gl.BACK;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.gl.cullFace(v);
        this.current = v;
        this.dirty = false;
    }
}
export class FrontFace extends BaseValue {
    getDefault() {
        return this.gl.CCW;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.gl.frontFace(v);
        this.current = v;
        this.dirty = false;
    }
}
export class ProgramValue extends BaseValue {
    getDefault() {
        return null;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.gl.useProgram(v);
        this.current = v;
        this.dirty = false;
    }
}
export class ActiveTextureUnit extends BaseValue {
    getDefault() {
        return this.gl.TEXTURE0;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.gl.activeTexture(v);
        this.current = v;
        this.dirty = false;
    }
}
export class Viewport extends BaseValue {
    getDefault() {
        const gl = this.gl;
        return [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight];
    }
    set(v) {
        const c = this.current;
        if (v[0] === c[0] && v[1] === c[1] && v[2] === c[2] && v[3] === c[3] && !this.dirty)
            return;
        this.gl.viewport(v[0], v[1], v[2], v[3]);
        this.current = v;
        this.dirty = false;
    }
}
export class BindFramebuffer extends BaseValue {
    getDefault() {
        return null;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, v);
        this.current = v;
        this.dirty = false;
    }
}
export class BindRenderbuffer extends BaseValue {
    getDefault() {
        return null;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        const gl = this.gl;
        gl.bindRenderbuffer(gl.RENDERBUFFER, v);
        this.current = v;
        this.dirty = false;
    }
}
export class BindTexture extends BaseValue {
    getDefault() {
        return null;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, v);
        this.current = v;
        this.dirty = false;
    }
}
export class BindVertexBuffer extends BaseValue {
    getDefault() {
        return null;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, v);
        this.current = v;
        this.dirty = false;
    }
}
export class BindElementBuffer extends BaseValue {
    getDefault() {
        return null;
    }
    set(v) {
        // Always rebind
        const gl = this.gl;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, v);
        this.current = v;
        this.dirty = false;
    }
}
export class BindVertexArrayOES extends BaseValue {
    constructor(context) {
        super(context);
        this.vao = context.extVertexArrayObject;
    }
    getDefault() {
        return null;
    }
    set(v) {
        if (!this.vao || v === this.current && !this.dirty)
            return;
        this.vao.bindVertexArrayOES(v);
        this.current = v;
        this.dirty = false;
    }
}
export class PixelStoreUnpack extends BaseValue {
    getDefault() {
        return 4;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        const gl = this.gl;
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, v);
        this.current = v;
        this.dirty = false;
    }
}
export class PixelStoreUnpackPremultiplyAlpha extends BaseValue {
    getDefault() {
        return false;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        const gl = this.gl;
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, v);
        this.current = v;
        this.dirty = false;
    }
}
export class PixelStoreUnpackFlipY extends BaseValue {
    getDefault() {
        return false;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        const gl = this.gl;
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, v);
        this.current = v;
        this.dirty = false;
    }
}
class FramebufferAttachment extends BaseValue {
    constructor(context, parent) {
        super(context);
        this.context = context;
        this.parent = parent;
    }
    getDefault() {
        return null;
    }
}
export class ColorAttachment extends FramebufferAttachment {
    setDirty() {
        this.dirty = true;
    }
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.context.bindFramebuffer.set(this.parent);
        // note: it's possible to attach a renderbuffer to the color
        // attachment point, but thus far MBGL only uses textures for color
        const gl = this.gl;
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, v, 0);
        this.current = v;
        this.dirty = false;
    }
}
export class DepthAttachment extends FramebufferAttachment {
    set(v) {
        if (v === this.current && !this.dirty)
            return;
        this.context.bindFramebuffer.set(this.parent);
        // note: it's possible to attach a texture to the depth attachment
        // point, but thus far MBGL only uses renderbuffers for depth
        const gl = this.gl;
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, v);
        this.current = v;
        this.dirty = false;
    }
}
//# sourceMappingURL=value.js.map