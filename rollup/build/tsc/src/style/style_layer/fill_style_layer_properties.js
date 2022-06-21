// This file is generated. Edit build/generate-style-code.ts, then run 'npm run codegen'.
/* eslint-disable */
import styleSpec from '../../style-spec/reference/latest';
import { Properties, DataConstantProperty, DataDrivenProperty, CrossFadedDataDrivenProperty } from '../properties';
const layout = new Properties({
    "fill-sort-key": new DataDrivenProperty(styleSpec["layout_fill"]["fill-sort-key"]),
});
const paint = new Properties({
    "fill-antialias": new DataConstantProperty(styleSpec["paint_fill"]["fill-antialias"]),
    "fill-opacity": new DataDrivenProperty(styleSpec["paint_fill"]["fill-opacity"]),
    "fill-color": new DataDrivenProperty(styleSpec["paint_fill"]["fill-color"]),
    "fill-outline-color": new DataDrivenProperty(styleSpec["paint_fill"]["fill-outline-color"]),
    "fill-translate": new DataConstantProperty(styleSpec["paint_fill"]["fill-translate"]),
    "fill-translate-anchor": new DataConstantProperty(styleSpec["paint_fill"]["fill-translate-anchor"]),
    "fill-pattern": new CrossFadedDataDrivenProperty(styleSpec["paint_fill"]["fill-pattern"]),
});
export default { paint, layout };
//# sourceMappingURL=fill_style_layer_properties.js.map