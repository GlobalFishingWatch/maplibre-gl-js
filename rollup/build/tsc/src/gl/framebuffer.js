import { ColorAttachment, DepthAttachment } from './value';
import assert from 'assert';
class Framebuffer {
    constructor(context, width, height, hasDepth) {
        this.context = context;
        this.width = width;
        this.height = height;
        const gl = context.gl;
        const fbo = this.framebuffer = gl.createFramebuffer();
        this.colorAttachment = new ColorAttachment(context, fbo);
        if (hasDepth) {
            this.depthAttachment = new DepthAttachment(context, fbo);
        }
        assert(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE);
    }
    destroy() {
        const gl = this.context.gl;
        const texture = this.colorAttachment.get();
        if (texture)
            gl.deleteTexture(texture);
        if (this.depthAttachment) {
            const renderbuffer = this.depthAttachment.get();
            if (renderbuffer)
                gl.deleteRenderbuffer(renderbuffer);
        }
        gl.deleteFramebuffer(this.framebuffer);
    }
}
export default Framebuffer;
//# sourceMappingURL=framebuffer.js.map