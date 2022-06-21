const ALWAYS = 0x0207;
const KEEP = 0x1E00;
class StencilMode {
    constructor(test, ref, mask, fail, depthFail, pass) {
        this.test = test;
        this.ref = ref;
        this.mask = mask;
        this.fail = fail;
        this.depthFail = depthFail;
        this.pass = pass;
    }
}
StencilMode.disabled = new StencilMode({ func: ALWAYS, mask: 0 }, 0, 0, KEEP, KEEP, KEEP);
export default StencilMode;
//# sourceMappingURL=stencil_mode.js.map