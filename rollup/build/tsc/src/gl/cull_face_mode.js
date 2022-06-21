const BACK = 0x0405;
const CCW = 0x0901;
class CullFaceMode {
    constructor(enable, mode, frontFace) {
        this.enable = enable;
        this.mode = mode;
        this.frontFace = frontFace;
    }
}
CullFaceMode.disabled = new CullFaceMode(false, BACK, CCW);
CullFaceMode.backCCW = new CullFaceMode(true, BACK, CCW);
export default CullFaceMode;
//# sourceMappingURL=cull_face_mode.js.map