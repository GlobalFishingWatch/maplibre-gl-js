import { UniformMatrix4f } from '../uniform_binding';
const clippingMaskUniforms = (context, locations) => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix)
});
const clippingMaskUniformValues = (matrix) => ({
    'u_matrix': matrix
});
export { clippingMaskUniforms, clippingMaskUniformValues };
//# sourceMappingURL=clipping_mask_program.js.map