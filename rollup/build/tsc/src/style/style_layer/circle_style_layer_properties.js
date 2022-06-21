// This file is generated. Edit build/generate-style-code.ts, then run 'npm run codegen'.
/* eslint-disable */
import styleSpec from '../../style-spec/reference/latest';
import { Properties, DataConstantProperty, DataDrivenProperty } from '../properties';
const layout = new Properties({
    "circle-sort-key": new DataDrivenProperty(styleSpec["layout_circle"]["circle-sort-key"]),
});
const paint = new Properties({
    "circle-radius": new DataDrivenProperty(styleSpec["paint_circle"]["circle-radius"]),
    "circle-color": new DataDrivenProperty(styleSpec["paint_circle"]["circle-color"]),
    "circle-blur": new DataDrivenProperty(styleSpec["paint_circle"]["circle-blur"]),
    "circle-opacity": new DataDrivenProperty(styleSpec["paint_circle"]["circle-opacity"]),
    "circle-translate": new DataConstantProperty(styleSpec["paint_circle"]["circle-translate"]),
    "circle-translate-anchor": new DataConstantProperty(styleSpec["paint_circle"]["circle-translate-anchor"]),
    "circle-pitch-scale": new DataConstantProperty(styleSpec["paint_circle"]["circle-pitch-scale"]),
    "circle-pitch-alignment": new DataConstantProperty(styleSpec["paint_circle"]["circle-pitch-alignment"]),
    "circle-stroke-width": new DataDrivenProperty(styleSpec["paint_circle"]["circle-stroke-width"]),
    "circle-stroke-color": new DataDrivenProperty(styleSpec["paint_circle"]["circle-stroke-color"]),
    "circle-stroke-opacity": new DataDrivenProperty(styleSpec["paint_circle"]["circle-stroke-opacity"]),
});
export default { paint, layout };
//# sourceMappingURL=circle_style_layer_properties.js.map