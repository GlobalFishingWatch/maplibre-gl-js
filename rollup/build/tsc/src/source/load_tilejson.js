import { pick, extend } from '../util/util';
import { getJSON, ResourceType } from '../util/ajax';
import browser from '../util/browser';
export default function (options, requestManager, callback) {
    const loaded = function (err, tileJSON) {
        if (err) {
            return callback(err);
        }
        else if (tileJSON) {
            const result = pick(
            // explicit source options take precedence over TileJSON
            extend(tileJSON, options), ['tiles', 'minzoom', 'maxzoom', 'attribution', 'maplibreLogo', 'bounds', 'scheme', 'tileSize', 'encoding']);
            if (tileJSON.vector_layers) {
                result.vectorLayers = tileJSON.vector_layers;
                result.vectorLayerIds = result.vectorLayers.map((layer) => { return layer.id; });
            }
            callback(null, result);
        }
    };
    if (options.url) {
        return getJSON(requestManager.transformRequest(options.url, ResourceType.Source), loaded);
    }
    else {
        return browser.frame(() => loaded(null, options));
    }
}
//# sourceMappingURL=load_tilejson.js.map