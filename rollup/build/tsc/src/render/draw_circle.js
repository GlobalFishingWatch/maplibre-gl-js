import StencilMode from '../gl/stencil_mode';
import DepthMode from '../gl/depth_mode';
import CullFaceMode from '../gl/cull_face_mode';
import { circleUniformValues } from './program/circle_program';
import SegmentVector from '../data/segment';
export default drawCircles;
function drawCircles(painter, sourceCache, layer, coords) {
    if (painter.renderPass !== 'translucent')
        return;
    const opacity = layer.paint.get('circle-opacity');
    const strokeWidth = layer.paint.get('circle-stroke-width');
    const strokeOpacity = layer.paint.get('circle-stroke-opacity');
    const sortFeaturesByKey = !layer.layout.get('circle-sort-key').isConstant();
    if (opacity.constantOr(1) === 0 && (strokeWidth.constantOr(1) === 0 || strokeOpacity.constantOr(1) === 0)) {
        return;
    }
    const context = painter.context;
    const gl = context.gl;
    const depthMode = painter.depthModeForSublayer(0, DepthMode.ReadOnly);
    // Turn off stencil testing to allow circles to be drawn across boundaries,
    // so that large circles are not clipped to tiles
    const stencilMode = StencilMode.disabled;
    const colorMode = painter.colorModeForRenderPass();
    const segmentsRenderStates = [];
    for (let i = 0; i < coords.length; i++) {
        const coord = coords[i];
        const tile = sourceCache.getTile(coord);
        const bucket = tile.getBucket(layer);
        if (!bucket)
            continue;
        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const program = painter.useProgram('circle', programConfiguration);
        const layoutVertexBuffer = bucket.layoutVertexBuffer;
        const indexBuffer = bucket.indexBuffer;
        const uniformValues = circleUniformValues(painter, coord, tile, layer);
        const state = {
            programConfiguration,
            program,
            layoutVertexBuffer,
            indexBuffer,
            uniformValues,
        };
        if (sortFeaturesByKey) {
            const oldSegments = bucket.segments.get();
            for (const segment of oldSegments) {
                segmentsRenderStates.push({
                    segments: new SegmentVector([segment]),
                    sortKey: segment.sortKey,
                    state
                });
            }
        }
        else {
            segmentsRenderStates.push({
                segments: bucket.segments,
                sortKey: 0,
                state
            });
        }
    }
    if (sortFeaturesByKey) {
        segmentsRenderStates.sort((a, b) => a.sortKey - b.sortKey);
    }
    for (const segmentsState of segmentsRenderStates) {
        const { programConfiguration, program, layoutVertexBuffer, indexBuffer, uniformValues } = segmentsState.state;
        const segments = segmentsState.segments;
        program.draw(context, gl.TRIANGLES, depthMode, stencilMode, colorMode, CullFaceMode.disabled, uniformValues, layer.id, layoutVertexBuffer, indexBuffer, segments, layer.paint, painter.transform.zoom, programConfiguration);
    }
}
//# sourceMappingURL=draw_circle.js.map