import { extend, pick } from '../util/util';
import { getImage, ResourceType } from '../util/ajax';
import { Event, ErrorEvent, Evented } from '../util/evented';
import loadTileJSON from './load_tilejson';
import TileBounds from './tile_bounds';
import Texture from '../render/texture';
import { cacheEntryPossiblyAdded } from '../util/tile_request_cache';
class RasterTileSource extends Evented {
    constructor(id, options, dispatcher, eventedParent) {
        super();
        this.id = id;
        this.dispatcher = dispatcher;
        this.setEventedParent(eventedParent);
        this.type = 'raster';
        this.minzoom = 0;
        this.maxzoom = 22;
        this.roundZoom = true;
        this.scheme = 'xyz';
        this.tileSize = 512;
        this._loaded = false;
        this._options = extend({ type: 'raster' }, options);
        extend(this, pick(options, ['url', 'scheme', 'tileSize']));
    }
    load() {
        this._loaded = false;
        this.fire(new Event('dataloading', { dataType: 'source' }));
        this._tileJSONRequest = loadTileJSON(this._options, this.map._requestManager, (err, tileJSON) => {
            this._tileJSONRequest = null;
            this._loaded = true;
            if (err) {
                this.fire(new ErrorEvent(err));
            }
            else if (tileJSON) {
                extend(this, tileJSON);
                if (tileJSON.bounds)
                    this.tileBounds = new TileBounds(tileJSON.bounds, this.minzoom, this.maxzoom);
                // `content` is included here to prevent a race condition where `Style#_updateSources` is called
                // before the TileJSON arrives. this makes sure the tiles needed are loaded once TileJSON arrives
                // ref: https://github.com/mapbox/mapbox-gl-js/pull/4347#discussion_r104418088
                this.fire(new Event('data', { dataType: 'source', sourceDataType: 'metadata' }));
                this.fire(new Event('data', { dataType: 'source', sourceDataType: 'content' }));
            }
        });
    }
    loaded() {
        return this._loaded;
    }
    onAdd(map) {
        this.map = map;
        this.load();
    }
    onRemove() {
        if (this._tileJSONRequest) {
            this._tileJSONRequest.cancel();
            this._tileJSONRequest = null;
        }
    }
    serialize() {
        return extend({}, this._options);
    }
    hasTile(tileID) {
        return !this.tileBounds || this.tileBounds.contains(tileID.canonical);
    }
    loadTile(tile, callback) {
        const url = tile.tileID.canonical.url(this.tiles, this.map.getPixelRatio(), this.scheme);
        tile.request = getImage(this.map._requestManager.transformRequest(url, ResourceType.Tile), (err, img) => {
            delete tile.request;
            if (tile.aborted) {
                tile.state = 'unloaded';
                callback(null);
            }
            else if (err) {
                tile.state = 'errored';
                callback(err);
            }
            else if (img) {
                if (this.map._refreshExpiredTiles)
                    tile.setExpiryData(img);
                delete img.cacheControl;
                delete img.expires;
                const context = this.map.painter.context;
                const gl = context.gl;
                tile.texture = this.map.painter.getTileTexture(img.width);
                if (tile.texture) {
                    tile.texture.update(img, { useMipmap: true });
                }
                else {
                    tile.texture = new Texture(context, img, gl.RGBA, { useMipmap: true });
                    tile.texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE, gl.LINEAR_MIPMAP_NEAREST);
                    if (context.extTextureFilterAnisotropic) {
                        gl.texParameterf(gl.TEXTURE_2D, context.extTextureFilterAnisotropic.TEXTURE_MAX_ANISOTROPY_EXT, context.extTextureFilterAnisotropicMax);
                    }
                }
                tile.state = 'loaded';
                cacheEntryPossiblyAdded(this.dispatcher);
                callback(null);
            }
        });
    }
    abortTile(tile, callback) {
        if (tile.request) {
            tile.request.cancel();
            delete tile.request;
        }
        callback();
    }
    unloadTile(tile, callback) {
        if (tile.texture)
            this.map.painter.saveTileTexture(tile.texture);
        callback();
    }
    hasTransition() {
        return false;
    }
}
export default RasterTileSource;
//# sourceMappingURL=raster_tile_source.js.map