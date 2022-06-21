import Protobuf from 'pbf';
import VT from '@mapbox/vector-tile';
import assert from 'assert';
import deref from '../../src/style-spec/deref';
import Style from '../../src/style/style';
import { Evented } from '../../src/util/evented';
import { RequestManager } from '../../src/util/request_manager';
import WorkerTile from '../../src/source/worker_tile';
import StyleLayerIndex from '../../src/style/style_layer_index';
class StubMap extends Evented {
    constructor() {
        super();
        this._requestManager = new RequestManager();
    }
    getPixelRatio() {
        return devicePixelRatio;
    }
}
const mapStub = new StubMap();
function createStyle(styleJSON) {
    return new Promise((resolve, reject) => {
        const style = new Style(mapStub);
        style.loadJSON(styleJSON);
        style
            .on('style.load', () => resolve(style))
            .on('error', reject);
    });
}
export default class TileParser {
    constructor(styleJSON, sourceID) {
        this.styleJSON = styleJSON;
        this.sourceID = sourceID;
        this.layerIndex = new StyleLayerIndex(deref(this.styleJSON.layers));
        this.glyphs = {};
        this.icons = {};
    }
    loadImages(params, callback) {
        const key = JSON.stringify(params);
        if (this.icons[key]) {
            callback(null, this.icons[key]);
        }
        else {
            this.style.getImages('', params, (err, icons) => {
                this.icons[key] = icons;
                callback(err, icons);
            });
        }
    }
    loadGlyphs(params, callback) {
        const key = JSON.stringify(params);
        if (this.glyphs[key]) {
            callback(null, this.glyphs[key]);
        }
        else {
            this.style.getGlyphs('', params, (err, glyphs) => {
                this.glyphs[key] = glyphs;
                callback(err, glyphs);
            });
        }
    }
    setup() {
        const parser = this;
        this.actor = {
            send(action, params, callback) {
                setTimeout(() => {
                    if (action === 'getImages') {
                        parser.loadImages(params, callback);
                    }
                    else if (action === 'getGlyphs') {
                        parser.loadGlyphs(params, callback);
                    }
                    else
                        assert(false);
                }, 0);
            }
        };
        return Promise.all([
            createStyle(this.styleJSON),
            fetch(this.styleJSON.sources[this.sourceID].url).then(response => response.json())
        ]).then(([style, tileJSON]) => {
            this.style = style;
            this.tileJSON = tileJSON;
        });
    }
    fetchTile(tileID) {
        return fetch(tileID.canonical.url(this.tileJSON.tiles, devicePixelRatio))
            .then(response => response.arrayBuffer())
            .then(buffer => ({ tileID, buffer }));
    }
    parseTile(tile, returnDependencies) {
        const workerTile = new WorkerTile({
            tileID: tile.tileID,
            zoom: tile.tileID.overscaledZ,
            tileSize: 512,
            showCollisionBoxes: false,
            source: this.sourceID,
            uid: '0',
            maxZoom: 22,
            pixelRatio: 1,
            request: { url: '' },
            returnDependencies,
            promoteId: undefined
        });
        const vectorTile = new VT.VectorTile(new Protobuf(tile.buffer));
        return new Promise((resolve, reject) => {
            workerTile.parse(vectorTile, this.layerIndex, [], this.actor, (err, result) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(result);
                }
            });
        });
    }
}
//# sourceMappingURL=tile_parser.js.map