const ALWAYS = 0x0207;
class DepthMode {
    constructor(depthFunc, depthMask, depthRange) {
        this.func = depthFunc;
        this.mask = depthMask;
        this.range = depthRange;
    }
}
DepthMode.ReadOnly = false;
DepthMode.ReadWrite = true;
DepthMode.disabled = new DepthMode(ALWAYS, DepthMode.ReadOnly, [0, 1]);
export default DepthMode;
//# sourceMappingURL=depth_mode.js.map