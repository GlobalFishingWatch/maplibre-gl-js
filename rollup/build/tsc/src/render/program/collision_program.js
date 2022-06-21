import { Uniform1f, Uniform2f, UniformMatrix4f } from '../uniform_binding';
import pixelsToTileUnits from '../../source/pixels_to_tile_units';
const collisionUniforms = (context, locations) => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_camera_to_center_distance': new Uniform1f(context, locations.u_camera_to_center_distance),
    'u_pixels_to_tile_units': new Uniform1f(context, locations.u_pixels_to_tile_units),
    'u_extrude_scale': new Uniform2f(context, locations.u_extrude_scale),
    'u_overscale_factor': new Uniform1f(context, locations.u_overscale_factor)
});
const collisionCircleUniforms = (context, locations) => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_inv_matrix': new UniformMatrix4f(context, locations.u_inv_matrix),
    'u_camera_to_center_distance': new Uniform1f(context, locations.u_camera_to_center_distance),
    'u_viewport_size': new Uniform2f(context, locations.u_viewport_size)
});
const collisionUniformValues = (matrix, transform, tile) => {
    const pixelRatio = pixelsToTileUnits(tile, 1, transform.zoom);
    const scale = Math.pow(2, transform.zoom - tile.tileID.overscaledZ);
    const overscaleFactor = tile.tileID.overscaleFactor();
    return {
        'u_matrix': matrix,
        'u_camera_to_center_distance': transform.cameraToCenterDistance,
        'u_pixels_to_tile_units': pixelRatio,
        'u_extrude_scale': [transform.pixelsToGLUnits[0] / (pixelRatio * scale),
            transform.pixelsToGLUnits[1] / (pixelRatio * scale)],
        'u_overscale_factor': overscaleFactor
    };
};
const collisionCircleUniformValues = (matrix, invMatrix, transform) => {
    return {
        'u_matrix': matrix,
        'u_inv_matrix': invMatrix,
        'u_camera_to_center_distance': transform.cameraToCenterDistance,
        'u_viewport_size': [transform.width, transform.height]
    };
};
export { collisionUniforms, collisionUniformValues, collisionCircleUniforms, collisionCircleUniformValues };
//# sourceMappingURL=collision_program.js.map