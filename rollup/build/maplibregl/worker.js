define(['./shared'], (function (performance) { 'use strict';

function stringify(obj) {
    const type = typeof obj;
    if (type === 'number' || type === 'boolean' || type === 'string' || obj === undefined || obj === null)
        return JSON.stringify(obj);
    if (Array.isArray(obj)) {
        let str = '[';
        for (const val of obj) {
            str += `${stringify(val)},`;
        }
        return `${str}]`;
    }
    const keys = Object.keys(obj).sort();
    let str = '{';
    for (let i = 0; i < keys.length; i++) {
        str += `${JSON.stringify(keys[i])}:${stringify(obj[keys[i]])},`;
    }
    return `${str}}`;
}
function getKey(layer) {
    let key = '';
    for (const k of performance.refProperties) {
        key += `/${stringify(layer[k])}`;
    }
    return key;
}
/**
 * Given an array of layers, return an array of arrays of layers where all
 * layers in each group have identical layout-affecting properties. These
 * are the properties that were formerly used by explicit `ref` mechanism
 * for layers: 'type', 'source', 'source-layer', 'minzoom', 'maxzoom',
 * 'filter', and 'layout'.
 *
 * The input is not modified. The output layers are references to the
 * input layers.
 *
 * @private
 * @param {Array<Layer>} layers
 * @param {Object} [cachedKeys] - an object to keep already calculated keys.
 * @returns {Array<Array<Layer>>}
 */
function groupByLayout(layers, cachedKeys) {
    const groups = {};
    for (let i = 0; i < layers.length; i++) {
        const k = (cachedKeys && cachedKeys[layers[i].id]) || getKey(layers[i]);
        // update the cache if there is one
        if (cachedKeys)
            cachedKeys[layers[i].id] = k;
        let group = groups[k];
        if (!group) {
            group = groups[k] = [];
        }
        group.push(layers[i]);
    }
    const result = [];
    for (const k in groups) {
        result.push(groups[k]);
    }
    return result;
}

class StyleLayerIndex {
    constructor(layerConfigs) {
        this.keyCache = {};
        if (layerConfigs) {
            this.replace(layerConfigs);
        }
    }
    replace(layerConfigs) {
        this._layerConfigs = {};
        this._layers = {};
        this.update(layerConfigs, []);
    }
    update(layerConfigs, removedIds) {
        for (const layerConfig of layerConfigs) {
            this._layerConfigs[layerConfig.id] = layerConfig;
            const layer = this._layers[layerConfig.id] = performance.createStyleLayer(layerConfig);
            layer._featureFilter = performance.createFilter(layer.filter);
            if (this.keyCache[layerConfig.id])
                delete this.keyCache[layerConfig.id];
        }
        for (const id of removedIds) {
            delete this.keyCache[id];
            delete this._layerConfigs[id];
            delete this._layers[id];
        }
        this.familiesBySource = {};
        const groups = groupByLayout(Object.values(this._layerConfigs), this.keyCache);
        for (const layerConfigs of groups) {
            const layers = layerConfigs.map((layerConfig) => this._layers[layerConfig.id]);
            const layer = layers[0];
            if (layer.visibility === 'none') {
                continue;
            }
            const sourceId = layer.source || '';
            let sourceGroup = this.familiesBySource[sourceId];
            if (!sourceGroup) {
                sourceGroup = this.familiesBySource[sourceId] = {};
            }
            const sourceLayerId = layer.sourceLayer || '_geojsonTileLayer';
            let sourceLayerFamilies = sourceGroup[sourceLayerId];
            if (!sourceLayerFamilies) {
                sourceLayerFamilies = sourceGroup[sourceLayerId] = [];
            }
            sourceLayerFamilies.push(layers);
        }
    }
}

const padding = 1;
class GlyphAtlas {
    constructor(stacks) {
        const positions = {};
        const bins = [];
        for (const stack in stacks) {
            const glyphs = stacks[stack];
            const stackPositions = positions[stack] = {};
            for (const id in glyphs) {
                const src = glyphs[+id];
                if (!src || src.bitmap.width === 0 || src.bitmap.height === 0)
                    continue;
                const bin = {
                    x: 0,
                    y: 0,
                    w: src.bitmap.width + 2 * padding,
                    h: src.bitmap.height + 2 * padding
                };
                bins.push(bin);
                stackPositions[id] = { rect: bin, metrics: src.metrics };
            }
        }
        const { w, h } = performance.potpack(bins);
        const image = new performance.AlphaImage({ width: w || 1, height: h || 1 });
        for (const stack in stacks) {
            const glyphs = stacks[stack];
            for (const id in glyphs) {
                const src = glyphs[+id];
                if (!src || src.bitmap.width === 0 || src.bitmap.height === 0)
                    continue;
                const bin = positions[stack][id].rect;
                performance.AlphaImage.copy(src.bitmap, image, { x: 0, y: 0 }, { x: bin.x + padding, y: bin.y + padding }, src.bitmap);
            }
        }
        this.image = image;
        this.positions = positions;
    }
}
performance.register('GlyphAtlas', GlyphAtlas);

class WorkerTile {
    constructor(params) {
        this.tileID = new performance.OverscaledTileID(params.tileID.overscaledZ, params.tileID.wrap, params.tileID.canonical.z, params.tileID.canonical.x, params.tileID.canonical.y);
        this.uid = params.uid;
        this.zoom = params.zoom;
        this.pixelRatio = params.pixelRatio;
        this.tileSize = params.tileSize;
        this.source = params.source;
        this.overscaling = this.tileID.overscaleFactor();
        this.showCollisionBoxes = params.showCollisionBoxes;
        this.collectResourceTiming = !!params.collectResourceTiming;
        this.returnDependencies = !!params.returnDependencies;
        this.promoteId = params.promoteId;
    }
    parse(data, layerIndex, availableImages, actor, callback) {
        this.status = 'parsing';
        this.data = data;
        this.collisionBoxArray = new performance.CollisionBoxArray();
        const sourceLayerCoder = new performance.DictionaryCoder(Object.keys(data.layers).sort());
        const featureIndex = new performance.FeatureIndex(this.tileID, this.promoteId);
        featureIndex.bucketLayerIDs = [];
        const buckets = {};
        const options = {
            featureIndex,
            iconDependencies: {},
            patternDependencies: {},
            glyphDependencies: {},
            availableImages
        };
        const layerFamilies = layerIndex.familiesBySource[this.source];
        for (const sourceLayerId in layerFamilies) {
            const sourceLayer = data.layers[sourceLayerId];
            if (!sourceLayer) {
                continue;
            }
            if (sourceLayer.version === 1) {
                performance.warnOnce(`Vector tile source "${this.source}" layer "${sourceLayerId}" ` +
                    'does not use vector tile spec v2 and therefore may have some rendering errors.');
            }
            const sourceLayerIndex = sourceLayerCoder.encode(sourceLayerId);
            const features = [];
            for (let index = 0; index < sourceLayer.length; index++) {
                const feature = sourceLayer.feature(index);
                const id = featureIndex.getId(feature, sourceLayerId);
                features.push({ feature, id, index, sourceLayerIndex });
            }
            for (const family of layerFamilies[sourceLayerId]) {
                const layer = family[0];
                performance.assert(layer.source === this.source);
                if (layer.minzoom && this.zoom < Math.floor(layer.minzoom))
                    continue;
                if (layer.maxzoom && this.zoom >= layer.maxzoom)
                    continue;
                if (layer.visibility === 'none')
                    continue;
                recalculateLayers(family, this.zoom, availableImages);
                const bucket = buckets[layer.id] = layer.createBucket({
                    index: featureIndex.bucketLayerIDs.length,
                    layers: family,
                    zoom: this.zoom,
                    pixelRatio: this.pixelRatio,
                    overscaling: this.overscaling,
                    collisionBoxArray: this.collisionBoxArray,
                    sourceLayerIndex,
                    sourceID: this.source
                });
                bucket.populate(features, options, this.tileID.canonical);
                featureIndex.bucketLayerIDs.push(family.map((l) => l.id));
            }
        }
        let error;
        let glyphMap;
        let iconMap;
        let patternMap;
        const stacks = performance.mapObject(options.glyphDependencies, (glyphs) => Object.keys(glyphs).map(Number));
        if (Object.keys(stacks).length) {
            actor.send('getGlyphs', { uid: this.uid, stacks }, (err, result) => {
                if (!error) {
                    error = err;
                    glyphMap = result;
                    maybePrepare.call(this);
                }
            });
        }
        else {
            glyphMap = {};
        }
        const icons = Object.keys(options.iconDependencies);
        if (icons.length) {
            actor.send('getImages', { icons, source: this.source, tileID: this.tileID, type: 'icons' }, (err, result) => {
                if (!error) {
                    error = err;
                    iconMap = result;
                    maybePrepare.call(this);
                }
            });
        }
        else {
            iconMap = {};
        }
        const patterns = Object.keys(options.patternDependencies);
        if (patterns.length) {
            actor.send('getImages', { icons: patterns, source: this.source, tileID: this.tileID, type: 'patterns' }, (err, result) => {
                if (!error) {
                    error = err;
                    patternMap = result;
                    maybePrepare.call(this);
                }
            });
        }
        else {
            patternMap = {};
        }
        maybePrepare.call(this);
        function maybePrepare() {
            if (error) {
                return callback(error);
            }
            else if (glyphMap && iconMap && patternMap) {
                const glyphAtlas = new GlyphAtlas(glyphMap);
                const imageAtlas = new performance.ImageAtlas(iconMap, patternMap);
                for (const key in buckets) {
                    const bucket = buckets[key];
                    if (bucket instanceof performance.SymbolBucket) {
                        recalculateLayers(bucket.layers, this.zoom, availableImages);
                        performance.performSymbolLayout(bucket, glyphMap, glyphAtlas.positions, iconMap, imageAtlas.iconPositions, this.showCollisionBoxes, this.tileID.canonical);
                    }
                    else if (bucket.hasPattern &&
                        (bucket instanceof performance.LineBucket ||
                            bucket instanceof performance.FillBucket ||
                            bucket instanceof performance.FillExtrusionBucket)) {
                        recalculateLayers(bucket.layers, this.zoom, availableImages);
                        bucket.addFeatures(options, this.tileID.canonical, imageAtlas.patternPositions);
                    }
                }
                this.status = 'done';
                callback(null, {
                    buckets: Object.values(buckets).filter(b => !b.isEmpty()),
                    featureIndex,
                    collisionBoxArray: this.collisionBoxArray,
                    glyphAtlasImage: glyphAtlas.image,
                    imageAtlas,
                    // Only used for benchmarking:
                    glyphMap: this.returnDependencies ? glyphMap : null,
                    iconMap: this.returnDependencies ? iconMap : null,
                    glyphPositions: this.returnDependencies ? glyphAtlas.positions : null
                });
            }
        }
    }
}
function recalculateLayers(layers, zoom, availableImages) {
    // Layers are shared and may have been used by a WorkerTile with a different zoom.
    const parameters = new performance.EvaluationParameters(zoom);
    for (const layer of layers) {
        layer.recalculate(parameters, availableImages);
    }
}

/**
 * @private
 */
function loadVectorTile(params, callback) {
    const request = performance.getArrayBuffer(params.request, (err, data, cacheControl, expires) => {
        if (err) {
            callback(err);
        }
        else if (data) {
            callback(null, {
                vectorTile: new performance.vectorTile.VectorTile(new performance.pbf(data)),
                rawData: data,
                cacheControl,
                expires
            });
        }
    });
    return () => {
        request.cancel();
        callback();
    };
}
/**
 * The {@link WorkerSource} implementation that supports {@link VectorTileSource}.
 * This class is designed to be easily reused to support custom source types
 * for data formats that can be parsed/converted into an in-memory VectorTile
 * representation.  To do so, create it with
 * `new VectorTileWorkerSource(actor, styleLayers, customLoadVectorDataFunction)`.
 *
 * @private
 */
class VectorTileWorkerSource {
    /**
     * @param [loadVectorData] Optional method for custom loading of a VectorTile
     * object based on parameters passed from the main-thread Source. See
     * {@link VectorTileWorkerSource#loadTile}. The default implementation simply
     * loads the pbf at `params.url`.
     * @private
     */
    constructor(actor, layerIndex, availableImages, loadVectorData) {
        this.actor = actor;
        this.layerIndex = layerIndex;
        this.availableImages = availableImages;
        this.loadVectorData = loadVectorData || loadVectorTile;
        this.loading = {};
        this.loaded = {};
    }
    /**
     * Implements {@link WorkerSource#loadTile}. Delegates to
     * {@link VectorTileWorkerSource#loadVectorData} (which by default expects
     * a `params.url` property) for fetching and producing a VectorTile object.
     * @private
     */
    loadTile(params, callback) {
        const uid = params.uid;
        if (!this.loading)
            this.loading = {};
        const perf = (params && params.request && params.request.collectResourceTiming) ?
            new performance.RequestPerformance(params.request) : false;
        const workerTile = this.loading[uid] = new WorkerTile(params);
        workerTile.abort = this.loadVectorData(params, (err, response) => {
            delete this.loading[uid];
            if (err || !response) {
                workerTile.status = 'done';
                this.loaded[uid] = workerTile;
                return callback(err);
            }
            const rawTileData = response.rawData;
            const cacheControl = {};
            if (response.expires)
                cacheControl.expires = response.expires;
            if (response.cacheControl)
                cacheControl.cacheControl = response.cacheControl;
            const resourceTiming = {};
            if (perf) {
                const resourceTimingData = perf.finish();
                // it's necessary to eval the result of getEntriesByName() here via parse/stringify
                // late evaluation in the main thread causes TypeError: illegal invocation
                if (resourceTimingData)
                    resourceTiming.resourceTiming = JSON.parse(JSON.stringify(resourceTimingData));
            }
            workerTile.vectorTile = response.vectorTile;
            workerTile.parse(response.vectorTile, this.layerIndex, this.availableImages, this.actor, (err, result) => {
                if (err || !result)
                    return callback(err);
                // Transferring a copy of rawTileData because the worker needs to retain its copy.
                callback(null, performance.extend({ rawTileData: rawTileData.slice(0) }, result, cacheControl, resourceTiming));
            });
            this.loaded = this.loaded || {};
            this.loaded[uid] = workerTile;
        });
    }
    /**
     * Implements {@link WorkerSource#reloadTile}.
     * @private
     */
    reloadTile(params, callback) {
        const loaded = this.loaded, uid = params.uid, vtSource = this;
        if (loaded && loaded[uid]) {
            const workerTile = loaded[uid];
            workerTile.showCollisionBoxes = params.showCollisionBoxes;
            const done = (err, data) => {
                const reloadCallback = workerTile.reloadCallback;
                if (reloadCallback) {
                    delete workerTile.reloadCallback;
                    workerTile.parse(workerTile.vectorTile, vtSource.layerIndex, this.availableImages, vtSource.actor, reloadCallback);
                }
                callback(err, data);
            };
            if (workerTile.status === 'parsing') {
                workerTile.reloadCallback = done;
            }
            else if (workerTile.status === 'done') {
                // if there was no vector tile data on the initial load, don't try and re-parse tile
                if (workerTile.vectorTile) {
                    workerTile.parse(workerTile.vectorTile, this.layerIndex, this.availableImages, this.actor, done);
                }
                else {
                    done();
                }
            }
        }
    }
    /**
     * Implements {@link WorkerSource#abortTile}.
     *
     * @param params
     * @param params.uid The UID for this tile.
     * @private
     */
    abortTile(params, callback) {
        const loading = this.loading, uid = params.uid;
        if (loading && loading[uid] && loading[uid].abort) {
            loading[uid].abort();
            delete loading[uid];
        }
        callback();
    }
    /**
     * Implements {@link WorkerSource#removeTile}.
     *
     * @param params
     * @param params.uid The UID for this tile.
     * @private
     */
    removeTile(params, callback) {
        const loaded = this.loaded, uid = params.uid;
        if (loaded && loaded[uid]) {
            delete loaded[uid];
        }
        callback();
    }
}

var vtPbf = {exports: {}};

'use strict';

var Point = performance.pointGeometry;
var VectorTileFeature = performance.vectorTile.VectorTileFeature;

var geojson_wrapper = GeoJSONWrapper$2;

// conform to vectortile api
function GeoJSONWrapper$2 (features, options) {
  this.options = options || {};
  this.features = features;
  this.length = features.length;
}

GeoJSONWrapper$2.prototype.feature = function (i) {
  return new FeatureWrapper$1(this.features[i], this.options.extent)
};

function FeatureWrapper$1 (feature, extent) {
  this.id = typeof feature.id === 'number' ? feature.id : undefined;
  this.type = feature.type;
  this.rawGeometry = feature.type === 1 ? [feature.geometry] : feature.geometry;
  this.properties = feature.tags;
  this.extent = extent || 4096;
}

FeatureWrapper$1.prototype.loadGeometry = function () {
  var rings = this.rawGeometry;
  this.geometry = [];

  for (var i = 0; i < rings.length; i++) {
    var ring = rings[i];
    var newRing = [];
    for (var j = 0; j < ring.length; j++) {
      newRing.push(new Point(ring[j][0], ring[j][1]));
    }
    this.geometry.push(newRing);
  }
  return this.geometry
};

FeatureWrapper$1.prototype.bbox = function () {
  if (!this.geometry) this.loadGeometry();

  var rings = this.geometry;
  var x1 = Infinity;
  var x2 = -Infinity;
  var y1 = Infinity;
  var y2 = -Infinity;

  for (var i = 0; i < rings.length; i++) {
    var ring = rings[i];

    for (var j = 0; j < ring.length; j++) {
      var coord = ring[j];

      x1 = Math.min(x1, coord.x);
      x2 = Math.max(x2, coord.x);
      y1 = Math.min(y1, coord.y);
      y2 = Math.max(y2, coord.y);
    }
  }

  return [x1, y1, x2, y2]
};

FeatureWrapper$1.prototype.toGeoJSON = VectorTileFeature.prototype.toGeoJSON;

var Pbf = performance.pbf;
var GeoJSONWrapper$1 = geojson_wrapper;

vtPbf.exports = fromVectorTileJs;
var fromVectorTileJs_1 = vtPbf.exports.fromVectorTileJs = fromVectorTileJs;
var fromGeojsonVt_1 = vtPbf.exports.fromGeojsonVt = fromGeojsonVt;
var GeoJSONWrapper_1 = vtPbf.exports.GeoJSONWrapper = GeoJSONWrapper$1;

/**
 * Serialize a vector-tile-js-created tile to pbf
 *
 * @param {Object} tile
 * @return {Buffer} uncompressed, pbf-serialized tile data
 */
function fromVectorTileJs (tile) {
  var out = new Pbf();
  writeTile(tile, out);
  return out.finish()
}

/**
 * Serialized a geojson-vt-created tile to pbf.
 *
 * @param {Object} layers - An object mapping layer names to geojson-vt-created vector tile objects
 * @param {Object} [options] - An object specifying the vector-tile specification version and extent that were used to create `layers`.
 * @param {Number} [options.version=1] - Version of vector-tile spec used
 * @param {Number} [options.extent=4096] - Extent of the vector tile
 * @return {Buffer} uncompressed, pbf-serialized tile data
 */
function fromGeojsonVt (layers, options) {
  options = options || {};
  var l = {};
  for (var k in layers) {
    l[k] = new GeoJSONWrapper$1(layers[k].features, options);
    l[k].name = k;
    l[k].version = options.version;
    l[k].extent = options.extent;
  }
  return fromVectorTileJs({ layers: l })
}

function writeTile (tile, pbf) {
  for (var key in tile.layers) {
    pbf.writeMessage(3, writeLayer, tile.layers[key]);
  }
}

function writeLayer (layer, pbf) {
  pbf.writeVarintField(15, layer.version || 1);
  pbf.writeStringField(1, layer.name || '');
  pbf.writeVarintField(5, layer.extent || 4096);

  var i;
  var context = {
    keys: [],
    values: [],
    keycache: {},
    valuecache: {}
  };

  for (i = 0; i < layer.length; i++) {
    context.feature = layer.feature(i);
    pbf.writeMessage(2, writeFeature, context);
  }

  var keys = context.keys;
  for (i = 0; i < keys.length; i++) {
    pbf.writeStringField(3, keys[i]);
  }

  var values = context.values;
  for (i = 0; i < values.length; i++) {
    pbf.writeMessage(4, writeValue, values[i]);
  }
}

function writeFeature (context, pbf) {
  var feature = context.feature;

  if (feature.id !== undefined) {
    pbf.writeVarintField(1, feature.id);
  }

  pbf.writeMessage(2, writeProperties, context);
  pbf.writeVarintField(3, feature.type);
  pbf.writeMessage(4, writeGeometry, feature);
}

function writeProperties (context, pbf) {
  var feature = context.feature;
  var keys = context.keys;
  var values = context.values;
  var keycache = context.keycache;
  var valuecache = context.valuecache;

  for (var key in feature.properties) {
    var value = feature.properties[key];

    var keyIndex = keycache[key];
    if (value === null) continue // don't encode null value properties

    if (typeof keyIndex === 'undefined') {
      keys.push(key);
      keyIndex = keys.length - 1;
      keycache[key] = keyIndex;
    }
    pbf.writeVarint(keyIndex);

    var type = typeof value;
    if (type !== 'string' && type !== 'boolean' && type !== 'number') {
      value = JSON.stringify(value);
    }
    var valueKey = type + ':' + value;
    var valueIndex = valuecache[valueKey];
    if (typeof valueIndex === 'undefined') {
      values.push(value);
      valueIndex = values.length - 1;
      valuecache[valueKey] = valueIndex;
    }
    pbf.writeVarint(valueIndex);
  }
}

function command (cmd, length) {
  return (length << 3) + (cmd & 0x7)
}

function zigzag (num) {
  return (num << 1) ^ (num >> 31)
}

function writeGeometry (feature, pbf) {
  var geometry = feature.loadGeometry();
  var type = feature.type;
  var x = 0;
  var y = 0;
  var rings = geometry.length;
  for (var r = 0; r < rings; r++) {
    var ring = geometry[r];
    var count = 1;
    if (type === 1) {
      count = ring.length;
    }
    pbf.writeVarint(command(1, count)); // moveto
    // do not write polygon closing path as lineto
    var lineCount = type === 3 ? ring.length - 1 : ring.length;
    for (var i = 0; i < lineCount; i++) {
      if (i === 1 && type !== 1) {
        pbf.writeVarint(command(2, lineCount - 1)); // lineto
      }
      var dx = ring[i].x - x;
      var dy = ring[i].y - y;
      pbf.writeVarint(zigzag(dx));
      pbf.writeVarint(zigzag(dy));
      x += dx;
      y += dy;
    }
    if (type === 3) {
      pbf.writeVarint(command(7, 1)); // closepath
    }
  }
}

function writeValue (value, pbf) {
  var type = typeof value;
  if (type === 'string') {
    pbf.writeStringField(1, value);
  } else if (type === 'boolean') {
    pbf.writeBooleanField(7, value);
  } else if (type === 'number') {
    if (value % 1 !== 0) {
      pbf.writeDoubleField(3, value);
    } else if (value < 0) {
      pbf.writeSVarintField(6, value);
    } else {
      pbf.writeVarintField(5, value);
    }
  }
}

var vtpbf = vtPbf.exports;

// calculate simplification data using optimized Douglas-Peucker algorithm

function simplify(coords, first, last, sqTolerance) {
    var maxSqDist = sqTolerance;
    var mid = (last - first) >> 1;
    var minPosToMid = last - first;
    var index;

    var ax = coords[first];
    var ay = coords[first + 1];
    var bx = coords[last];
    var by = coords[last + 1];

    for (var i = first + 3; i < last; i += 3) {
        var d = getSqSegDist(coords[i], coords[i + 1], ax, ay, bx, by);

        if (d > maxSqDist) {
            index = i;
            maxSqDist = d;

        } else if (d === maxSqDist) {
            // a workaround to ensure we choose a pivot close to the middle of the list,
            // reducing recursion depth, for certain degenerate inputs
            // https://github.com/mapbox/geojson-vt/issues/104
            var posToMid = Math.abs(i - mid);
            if (posToMid < minPosToMid) {
                index = i;
                minPosToMid = posToMid;
            }
        }
    }

    if (maxSqDist > sqTolerance) {
        if (index - first > 3) simplify(coords, first, index, sqTolerance);
        coords[index + 2] = maxSqDist;
        if (last - index > 3) simplify(coords, index, last, sqTolerance);
    }
}

// square distance from a point to a segment
function getSqSegDist(px, py, x, y, bx, by) {

    var dx = bx - x;
    var dy = by - y;

    if (dx !== 0 || dy !== 0) {

        var t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);

        if (t > 1) {
            x = bx;
            y = by;

        } else if (t > 0) {
            x += dx * t;
            y += dy * t;
        }
    }

    dx = px - x;
    dy = py - y;

    return dx * dx + dy * dy;
}

function createFeature(id, type, geom, tags) {
    var feature = {
        id: typeof id === 'undefined' ? null : id,
        type: type,
        geometry: geom,
        tags: tags,
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    };
    calcBBox(feature);
    return feature;
}

function calcBBox(feature) {
    var geom = feature.geometry;
    var type = feature.type;

    if (type === 'Point' || type === 'MultiPoint' || type === 'LineString') {
        calcLineBBox(feature, geom);

    } else if (type === 'Polygon' || type === 'MultiLineString') {
        for (var i = 0; i < geom.length; i++) {
            calcLineBBox(feature, geom[i]);
        }

    } else if (type === 'MultiPolygon') {
        for (i = 0; i < geom.length; i++) {
            for (var j = 0; j < geom[i].length; j++) {
                calcLineBBox(feature, geom[i][j]);
            }
        }
    }
}

function calcLineBBox(feature, geom) {
    for (var i = 0; i < geom.length; i += 3) {
        feature.minX = Math.min(feature.minX, geom[i]);
        feature.minY = Math.min(feature.minY, geom[i + 1]);
        feature.maxX = Math.max(feature.maxX, geom[i]);
        feature.maxY = Math.max(feature.maxY, geom[i + 1]);
    }
}

// converts GeoJSON feature into an intermediate projected JSON vector format with simplification data

function convert(data, options) {
    var features = [];
    if (data.type === 'FeatureCollection') {
        for (var i = 0; i < data.features.length; i++) {
            convertFeature(features, data.features[i], options, i);
        }

    } else if (data.type === 'Feature') {
        convertFeature(features, data, options);

    } else {
        // single geometry or a geometry collection
        convertFeature(features, {geometry: data}, options);
    }

    return features;
}

function convertFeature(features, geojson, options, index) {
    if (!geojson.geometry) return;

    var coords = geojson.geometry.coordinates;
    var type = geojson.geometry.type;
    var tolerance = Math.pow(options.tolerance / ((1 << options.maxZoom) * options.extent), 2);
    var geometry = [];
    var id = geojson.id;
    if (options.promoteId) {
        id = geojson.properties[options.promoteId];
    } else if (options.generateId) {
        id = index || 0;
    }
    if (type === 'Point') {
        convertPoint(coords, geometry);

    } else if (type === 'MultiPoint') {
        for (var i = 0; i < coords.length; i++) {
            convertPoint(coords[i], geometry);
        }

    } else if (type === 'LineString') {
        convertLine(coords, geometry, tolerance, false);

    } else if (type === 'MultiLineString') {
        if (options.lineMetrics) {
            // explode into linestrings to be able to track metrics
            for (i = 0; i < coords.length; i++) {
                geometry = [];
                convertLine(coords[i], geometry, tolerance, false);
                features.push(createFeature(id, 'LineString', geometry, geojson.properties));
            }
            return;
        } else {
            convertLines(coords, geometry, tolerance, false);
        }

    } else if (type === 'Polygon') {
        convertLines(coords, geometry, tolerance, true);

    } else if (type === 'MultiPolygon') {
        for (i = 0; i < coords.length; i++) {
            var polygon = [];
            convertLines(coords[i], polygon, tolerance, true);
            geometry.push(polygon);
        }
    } else if (type === 'GeometryCollection') {
        for (i = 0; i < geojson.geometry.geometries.length; i++) {
            convertFeature(features, {
                id: id,
                geometry: geojson.geometry.geometries[i],
                properties: geojson.properties
            }, options, index);
        }
        return;
    } else {
        throw new Error('Input data is not a valid GeoJSON object.');
    }

    features.push(createFeature(id, type, geometry, geojson.properties));
}

function convertPoint(coords, out) {
    out.push(projectX(coords[0]));
    out.push(projectY(coords[1]));
    out.push(0);
}

function convertLine(ring, out, tolerance, isPolygon) {
    var x0, y0;
    var size = 0;

    for (var j = 0; j < ring.length; j++) {
        var x = projectX(ring[j][0]);
        var y = projectY(ring[j][1]);

        out.push(x);
        out.push(y);
        out.push(0);

        if (j > 0) {
            if (isPolygon) {
                size += (x0 * y - x * y0) / 2; // area
            } else {
                size += Math.sqrt(Math.pow(x - x0, 2) + Math.pow(y - y0, 2)); // length
            }
        }
        x0 = x;
        y0 = y;
    }

    var last = out.length - 3;
    out[2] = 1;
    simplify(out, 0, last, tolerance);
    out[last + 2] = 1;

    out.size = Math.abs(size);
    out.start = 0;
    out.end = out.size;
}

function convertLines(rings, out, tolerance, isPolygon) {
    for (var i = 0; i < rings.length; i++) {
        var geom = [];
        convertLine(rings[i], geom, tolerance, isPolygon);
        out.push(geom);
    }
}

function projectX(x) {
    return x / 360 + 0.5;
}

function projectY(y) {
    var sin = Math.sin(y * Math.PI / 180);
    var y2 = 0.5 - 0.25 * Math.log((1 + sin) / (1 - sin)) / Math.PI;
    return y2 < 0 ? 0 : y2 > 1 ? 1 : y2;
}

/* clip features between two axis-parallel lines:
 *     |        |
 *  ___|___     |     /
 * /   |   \____|____/
 *     |        |
 */

function clip(features, scale, k1, k2, axis, minAll, maxAll, options) {

    k1 /= scale;
    k2 /= scale;

    if (minAll >= k1 && maxAll < k2) return features; // trivial accept
    else if (maxAll < k1 || minAll >= k2) return null; // trivial reject

    var clipped = [];

    for (var i = 0; i < features.length; i++) {

        var feature = features[i];
        var geometry = feature.geometry;
        var type = feature.type;

        var min = axis === 0 ? feature.minX : feature.minY;
        var max = axis === 0 ? feature.maxX : feature.maxY;

        if (min >= k1 && max < k2) { // trivial accept
            clipped.push(feature);
            continue;
        } else if (max < k1 || min >= k2) { // trivial reject
            continue;
        }

        var newGeometry = [];

        if (type === 'Point' || type === 'MultiPoint') {
            clipPoints(geometry, newGeometry, k1, k2, axis);

        } else if (type === 'LineString') {
            clipLine(geometry, newGeometry, k1, k2, axis, false, options.lineMetrics);

        } else if (type === 'MultiLineString') {
            clipLines(geometry, newGeometry, k1, k2, axis, false);

        } else if (type === 'Polygon') {
            clipLines(geometry, newGeometry, k1, k2, axis, true);

        } else if (type === 'MultiPolygon') {
            for (var j = 0; j < geometry.length; j++) {
                var polygon = [];
                clipLines(geometry[j], polygon, k1, k2, axis, true);
                if (polygon.length) {
                    newGeometry.push(polygon);
                }
            }
        }

        if (newGeometry.length) {
            if (options.lineMetrics && type === 'LineString') {
                for (j = 0; j < newGeometry.length; j++) {
                    clipped.push(createFeature(feature.id, type, newGeometry[j], feature.tags));
                }
                continue;
            }

            if (type === 'LineString' || type === 'MultiLineString') {
                if (newGeometry.length === 1) {
                    type = 'LineString';
                    newGeometry = newGeometry[0];
                } else {
                    type = 'MultiLineString';
                }
            }
            if (type === 'Point' || type === 'MultiPoint') {
                type = newGeometry.length === 3 ? 'Point' : 'MultiPoint';
            }

            clipped.push(createFeature(feature.id, type, newGeometry, feature.tags));
        }
    }

    return clipped.length ? clipped : null;
}

function clipPoints(geom, newGeom, k1, k2, axis) {
    for (var i = 0; i < geom.length; i += 3) {
        var a = geom[i + axis];

        if (a >= k1 && a <= k2) {
            newGeom.push(geom[i]);
            newGeom.push(geom[i + 1]);
            newGeom.push(geom[i + 2]);
        }
    }
}

function clipLine(geom, newGeom, k1, k2, axis, isPolygon, trackMetrics) {

    var slice = newSlice(geom);
    var intersect = axis === 0 ? intersectX : intersectY;
    var len = geom.start;
    var segLen, t;

    for (var i = 0; i < geom.length - 3; i += 3) {
        var ax = geom[i];
        var ay = geom[i + 1];
        var az = geom[i + 2];
        var bx = geom[i + 3];
        var by = geom[i + 4];
        var a = axis === 0 ? ax : ay;
        var b = axis === 0 ? bx : by;
        var exited = false;

        if (trackMetrics) segLen = Math.sqrt(Math.pow(ax - bx, 2) + Math.pow(ay - by, 2));

        if (a < k1) {
            // ---|-->  | (line enters the clip region from the left)
            if (b > k1) {
                t = intersect(slice, ax, ay, bx, by, k1);
                if (trackMetrics) slice.start = len + segLen * t;
            }
        } else if (a > k2) {
            // |  <--|--- (line enters the clip region from the right)
            if (b < k2) {
                t = intersect(slice, ax, ay, bx, by, k2);
                if (trackMetrics) slice.start = len + segLen * t;
            }
        } else {
            addPoint(slice, ax, ay, az);
        }
        if (b < k1 && a >= k1) {
            // <--|---  | or <--|-----|--- (line exits the clip region on the left)
            t = intersect(slice, ax, ay, bx, by, k1);
            exited = true;
        }
        if (b > k2 && a <= k2) {
            // |  ---|--> or ---|-----|--> (line exits the clip region on the right)
            t = intersect(slice, ax, ay, bx, by, k2);
            exited = true;
        }

        if (!isPolygon && exited) {
            if (trackMetrics) slice.end = len + segLen * t;
            newGeom.push(slice);
            slice = newSlice(geom);
        }

        if (trackMetrics) len += segLen;
    }

    // add the last point
    var last = geom.length - 3;
    ax = geom[last];
    ay = geom[last + 1];
    az = geom[last + 2];
    a = axis === 0 ? ax : ay;
    if (a >= k1 && a <= k2) addPoint(slice, ax, ay, az);

    // close the polygon if its endpoints are not the same after clipping
    last = slice.length - 3;
    if (isPolygon && last >= 3 && (slice[last] !== slice[0] || slice[last + 1] !== slice[1])) {
        addPoint(slice, slice[0], slice[1], slice[2]);
    }

    // add the final slice
    if (slice.length) {
        newGeom.push(slice);
    }
}

function newSlice(line) {
    var slice = [];
    slice.size = line.size;
    slice.start = line.start;
    slice.end = line.end;
    return slice;
}

function clipLines(geom, newGeom, k1, k2, axis, isPolygon) {
    for (var i = 0; i < geom.length; i++) {
        clipLine(geom[i], newGeom, k1, k2, axis, isPolygon, false);
    }
}

function addPoint(out, x, y, z) {
    out.push(x);
    out.push(y);
    out.push(z);
}

function intersectX(out, ax, ay, bx, by, x) {
    var t = (x - ax) / (bx - ax);
    out.push(x);
    out.push(ay + (by - ay) * t);
    out.push(1);
    return t;
}

function intersectY(out, ax, ay, bx, by, y) {
    var t = (y - ay) / (by - ay);
    out.push(ax + (bx - ax) * t);
    out.push(y);
    out.push(1);
    return t;
}

function wrap(features, options) {
    var buffer = options.buffer / options.extent;
    var merged = features;
    var left  = clip(features, 1, -1 - buffer, buffer,     0, -1, 2, options); // left world copy
    var right = clip(features, 1,  1 - buffer, 2 + buffer, 0, -1, 2, options); // right world copy

    if (left || right) {
        merged = clip(features, 1, -buffer, 1 + buffer, 0, -1, 2, options) || []; // center world copy

        if (left) merged = shiftFeatureCoords(left, 1).concat(merged); // merge left into center
        if (right) merged = merged.concat(shiftFeatureCoords(right, -1)); // merge right into center
    }

    return merged;
}

function shiftFeatureCoords(features, offset) {
    var newFeatures = [];

    for (var i = 0; i < features.length; i++) {
        var feature = features[i],
            type = feature.type;

        var newGeometry;

        if (type === 'Point' || type === 'MultiPoint' || type === 'LineString') {
            newGeometry = shiftCoords(feature.geometry, offset);

        } else if (type === 'MultiLineString' || type === 'Polygon') {
            newGeometry = [];
            for (var j = 0; j < feature.geometry.length; j++) {
                newGeometry.push(shiftCoords(feature.geometry[j], offset));
            }
        } else if (type === 'MultiPolygon') {
            newGeometry = [];
            for (j = 0; j < feature.geometry.length; j++) {
                var newPolygon = [];
                for (var k = 0; k < feature.geometry[j].length; k++) {
                    newPolygon.push(shiftCoords(feature.geometry[j][k], offset));
                }
                newGeometry.push(newPolygon);
            }
        }

        newFeatures.push(createFeature(feature.id, type, newGeometry, feature.tags));
    }

    return newFeatures;
}

function shiftCoords(points, offset) {
    var newPoints = [];
    newPoints.size = points.size;

    if (points.start !== undefined) {
        newPoints.start = points.start;
        newPoints.end = points.end;
    }

    for (var i = 0; i < points.length; i += 3) {
        newPoints.push(points[i] + offset, points[i + 1], points[i + 2]);
    }
    return newPoints;
}

// Transforms the coordinates of each feature in the given tile from
// mercator-projected space into (extent x extent) tile space.
function transformTile(tile, extent) {
    if (tile.transformed) return tile;

    var z2 = 1 << tile.z,
        tx = tile.x,
        ty = tile.y,
        i, j, k;

    for (i = 0; i < tile.features.length; i++) {
        var feature = tile.features[i],
            geom = feature.geometry,
            type = feature.type;

        feature.geometry = [];

        if (type === 1) {
            for (j = 0; j < geom.length; j += 2) {
                feature.geometry.push(transformPoint(geom[j], geom[j + 1], extent, z2, tx, ty));
            }
        } else {
            for (j = 0; j < geom.length; j++) {
                var ring = [];
                for (k = 0; k < geom[j].length; k += 2) {
                    ring.push(transformPoint(geom[j][k], geom[j][k + 1], extent, z2, tx, ty));
                }
                feature.geometry.push(ring);
            }
        }
    }

    tile.transformed = true;

    return tile;
}

function transformPoint(x, y, extent, z2, tx, ty) {
    return [
        Math.round(extent * (x * z2 - tx)),
        Math.round(extent * (y * z2 - ty))];
}

function createTile(features, z, tx, ty, options) {
    var tolerance = z === options.maxZoom ? 0 : options.tolerance / ((1 << z) * options.extent);
    var tile = {
        features: [],
        numPoints: 0,
        numSimplified: 0,
        numFeatures: 0,
        source: null,
        x: tx,
        y: ty,
        z: z,
        transformed: false,
        minX: 2,
        minY: 1,
        maxX: -1,
        maxY: 0
    };
    for (var i = 0; i < features.length; i++) {
        tile.numFeatures++;
        addFeature(tile, features[i], tolerance, options);

        var minX = features[i].minX;
        var minY = features[i].minY;
        var maxX = features[i].maxX;
        var maxY = features[i].maxY;

        if (minX < tile.minX) tile.minX = minX;
        if (minY < tile.minY) tile.minY = minY;
        if (maxX > tile.maxX) tile.maxX = maxX;
        if (maxY > tile.maxY) tile.maxY = maxY;
    }
    return tile;
}

function addFeature(tile, feature, tolerance, options) {

    var geom = feature.geometry,
        type = feature.type,
        simplified = [];

    if (type === 'Point' || type === 'MultiPoint') {
        for (var i = 0; i < geom.length; i += 3) {
            simplified.push(geom[i]);
            simplified.push(geom[i + 1]);
            tile.numPoints++;
            tile.numSimplified++;
        }

    } else if (type === 'LineString') {
        addLine(simplified, geom, tile, tolerance, false, false);

    } else if (type === 'MultiLineString' || type === 'Polygon') {
        for (i = 0; i < geom.length; i++) {
            addLine(simplified, geom[i], tile, tolerance, type === 'Polygon', i === 0);
        }

    } else if (type === 'MultiPolygon') {

        for (var k = 0; k < geom.length; k++) {
            var polygon = geom[k];
            for (i = 0; i < polygon.length; i++) {
                addLine(simplified, polygon[i], tile, tolerance, true, i === 0);
            }
        }
    }

    if (simplified.length) {
        var tags = feature.tags || null;
        if (type === 'LineString' && options.lineMetrics) {
            tags = {};
            for (var key in feature.tags) tags[key] = feature.tags[key];
            tags['mapbox_clip_start'] = geom.start / geom.size;
            tags['mapbox_clip_end'] = geom.end / geom.size;
        }
        var tileFeature = {
            geometry: simplified,
            type: type === 'Polygon' || type === 'MultiPolygon' ? 3 :
                type === 'LineString' || type === 'MultiLineString' ? 2 : 1,
            tags: tags
        };
        if (feature.id !== null) {
            tileFeature.id = feature.id;
        }
        tile.features.push(tileFeature);
    }
}

function addLine(result, geom, tile, tolerance, isPolygon, isOuter) {
    var sqTolerance = tolerance * tolerance;

    if (tolerance > 0 && (geom.size < (isPolygon ? sqTolerance : tolerance))) {
        tile.numPoints += geom.length / 3;
        return;
    }

    var ring = [];

    for (var i = 0; i < geom.length; i += 3) {
        if (tolerance === 0 || geom[i + 2] > sqTolerance) {
            tile.numSimplified++;
            ring.push(geom[i]);
            ring.push(geom[i + 1]);
        }
        tile.numPoints++;
    }

    if (isPolygon) rewind$1(ring, isOuter);

    result.push(ring);
}

function rewind$1(ring, clockwise) {
    var area = 0;
    for (var i = 0, len = ring.length, j = len - 2; i < len; j = i, i += 2) {
        area += (ring[i] - ring[j]) * (ring[i + 1] + ring[j + 1]);
    }
    if (area > 0 === clockwise) {
        for (i = 0, len = ring.length; i < len / 2; i += 2) {
            var x = ring[i];
            var y = ring[i + 1];
            ring[i] = ring[len - 2 - i];
            ring[i + 1] = ring[len - 1 - i];
            ring[len - 2 - i] = x;
            ring[len - 1 - i] = y;
        }
    }
}

function geojsonvt(data, options) {
    return new GeoJSONVT(data, options);
}

function GeoJSONVT(data, options) {
    options = this.options = extend$1(Object.create(this.options), options);

    var debug = options.debug;

    if (debug) console.time('preprocess data');

    if (options.maxZoom < 0 || options.maxZoom > 24) throw new Error('maxZoom should be in the 0-24 range');
    if (options.promoteId && options.generateId) throw new Error('promoteId and generateId cannot be used together.');

    var features = convert(data, options);

    this.tiles = {};
    this.tileCoords = [];

    if (debug) {
        console.timeEnd('preprocess data');
        console.log('index: maxZoom: %d, maxPoints: %d', options.indexMaxZoom, options.indexMaxPoints);
        console.time('generate tiles');
        this.stats = {};
        this.total = 0;
    }

    features = wrap(features, options);

    // start slicing from the top tile down
    if (features.length) this.splitTile(features, 0, 0, 0);

    if (debug) {
        if (features.length) console.log('features: %d, points: %d', this.tiles[0].numFeatures, this.tiles[0].numPoints);
        console.timeEnd('generate tiles');
        console.log('tiles generated:', this.total, JSON.stringify(this.stats));
    }
}

GeoJSONVT.prototype.options = {
    maxZoom: 14,            // max zoom to preserve detail on
    indexMaxZoom: 5,        // max zoom in the tile index
    indexMaxPoints: 100000, // max number of points per tile in the tile index
    tolerance: 3,           // simplification tolerance (higher means simpler)
    extent: 4096,           // tile extent
    buffer: 64,             // tile buffer on each side
    lineMetrics: false,     // whether to calculate line metrics
    promoteId: null,        // name of a feature property to be promoted to feature.id
    generateId: false,      // whether to generate feature ids. Cannot be used with promoteId
    debug: 0                // logging level (0, 1 or 2)
};

GeoJSONVT.prototype.splitTile = function (features, z, x, y, cz, cx, cy) {

    var stack = [features, z, x, y],
        options = this.options,
        debug = options.debug;

    // avoid recursion by using a processing queue
    while (stack.length) {
        y = stack.pop();
        x = stack.pop();
        z = stack.pop();
        features = stack.pop();

        var z2 = 1 << z,
            id = toID(z, x, y),
            tile = this.tiles[id];

        if (!tile) {
            if (debug > 1) console.time('creation');

            tile = this.tiles[id] = createTile(features, z, x, y, options);
            this.tileCoords.push({z: z, x: x, y: y});

            if (debug) {
                if (debug > 1) {
                    console.log('tile z%d-%d-%d (features: %d, points: %d, simplified: %d)',
                        z, x, y, tile.numFeatures, tile.numPoints, tile.numSimplified);
                    console.timeEnd('creation');
                }
                var key = 'z' + z;
                this.stats[key] = (this.stats[key] || 0) + 1;
                this.total++;
            }
        }

        // save reference to original geometry in tile so that we can drill down later if we stop now
        tile.source = features;

        // if it's the first-pass tiling
        if (!cz) {
            // stop tiling if we reached max zoom, or if the tile is too simple
            if (z === options.indexMaxZoom || tile.numPoints <= options.indexMaxPoints) continue;

        // if a drilldown to a specific tile
        } else {
            // stop tiling if we reached base zoom or our target tile zoom
            if (z === options.maxZoom || z === cz) continue;

            // stop tiling if it's not an ancestor of the target tile
            var m = 1 << (cz - z);
            if (x !== Math.floor(cx / m) || y !== Math.floor(cy / m)) continue;
        }

        // if we slice further down, no need to keep source geometry
        tile.source = null;

        if (features.length === 0) continue;

        if (debug > 1) console.time('clipping');

        // values we'll use for clipping
        var k1 = 0.5 * options.buffer / options.extent,
            k2 = 0.5 - k1,
            k3 = 0.5 + k1,
            k4 = 1 + k1,
            tl, bl, tr, br, left, right;

        tl = bl = tr = br = null;

        left  = clip(features, z2, x - k1, x + k3, 0, tile.minX, tile.maxX, options);
        right = clip(features, z2, x + k2, x + k4, 0, tile.minX, tile.maxX, options);
        features = null;

        if (left) {
            tl = clip(left, z2, y - k1, y + k3, 1, tile.minY, tile.maxY, options);
            bl = clip(left, z2, y + k2, y + k4, 1, tile.minY, tile.maxY, options);
            left = null;
        }

        if (right) {
            tr = clip(right, z2, y - k1, y + k3, 1, tile.minY, tile.maxY, options);
            br = clip(right, z2, y + k2, y + k4, 1, tile.minY, tile.maxY, options);
            right = null;
        }

        if (debug > 1) console.timeEnd('clipping');

        stack.push(tl || [], z + 1, x * 2,     y * 2);
        stack.push(bl || [], z + 1, x * 2,     y * 2 + 1);
        stack.push(tr || [], z + 1, x * 2 + 1, y * 2);
        stack.push(br || [], z + 1, x * 2 + 1, y * 2 + 1);
    }
};

GeoJSONVT.prototype.getTile = function (z, x, y) {
    var options = this.options,
        extent = options.extent,
        debug = options.debug;

    if (z < 0 || z > 24) return null;

    var z2 = 1 << z;
    x = ((x % z2) + z2) % z2; // wrap tile x coordinate

    var id = toID(z, x, y);
    if (this.tiles[id]) return transformTile(this.tiles[id], extent);

    if (debug > 1) console.log('drilling down to z%d-%d-%d', z, x, y);

    var z0 = z,
        x0 = x,
        y0 = y,
        parent;

    while (!parent && z0 > 0) {
        z0--;
        x0 = Math.floor(x0 / 2);
        y0 = Math.floor(y0 / 2);
        parent = this.tiles[toID(z0, x0, y0)];
    }

    if (!parent || !parent.source) return null;

    // if we found a parent tile containing the original geometry, we can drill down from it
    if (debug > 1) console.log('found parent tile z%d-%d-%d', z0, x0, y0);

    if (debug > 1) console.time('drilling down');
    this.splitTile(parent.source, z0, x0, y0, z, x, y);
    if (debug > 1) console.timeEnd('drilling down');

    return this.tiles[id] ? transformTile(this.tiles[id], extent) : null;
};

function toID(z, x, y) {
    return (((1 << z) * y + x) * 32) + z;
}

function extend$1(dest, src) {
    for (var i in src) dest[i] = src[i];
    return dest;
}

const toGeoJSON = performance.vectorTile.VectorTileFeature.prototype.toGeoJSON;
class FeatureWrapper {
    constructor(feature, extent = performance.EXTENT) {
        this._feature = feature;
        this.extent = extent;
        this.type = feature.type;
        this.properties = feature.tags;
        // If the feature has a top-level `id` property, copy it over, but only
        // if it can be coerced to an integer, because this wrapper is used for
        // serializing geojson feature data into vector tile PBF data, and the
        // vector tile spec only supports integer values for feature ids --
        // allowing non-integer values here results in a non-compliant PBF
        // that causes an exception when it is parsed with vector-tile-js
        if ('id' in feature && !isNaN(feature.id)) {
            this.id = parseInt(feature.id, 10);
        }
    }
    loadGeometry() {
        if (this._feature.type === 1) {
            const geometry = [];
            for (const point of this._feature.geometry) {
                geometry.push([new performance.pointGeometry(point[0], point[1])]);
            }
            return geometry;
        }
        else {
            const geometry = [];
            for (const ring of this._feature.geometry) {
                const newRing = [];
                for (const point of ring) {
                    newRing.push(new performance.pointGeometry(point[0], point[1]));
                }
                geometry.push(newRing);
            }
            return geometry;
        }
    }
    toGeoJSON(x, y, z) {
        return toGeoJSON.call(this, x, y, z);
    }
}
class GeoJSONWrapper {
    constructor(features, options) {
        const { name = '_geojsonTileLayer', extent = performance.EXTENT } = options || {};
        this.layers = { [name]: this };
        this.name = name;
        this.extent = extent;
        this.length = features.length;
        this._features = features;
    }
    feature(i) {
        return new FeatureWrapper(this._features[i], this.extent);
    }
}

class MultiSourceLayerGeoJSONWrapper {
    constructor(sourceLayers, options) {
        const { extent = performance.EXTENT } = options || {};
        const layers = {};
        Object.keys(sourceLayers).forEach((sourceLayerName) => {
            layers[sourceLayerName] = new GeoJSONWrapper(sourceLayers[sourceLayerName].features, {
                name: sourceLayerName,
                extent
            });
        });
        this.layers = layers;
    }
}

var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

var check = function (it) {
  return it && it.Math == Math && it;
};

// https://github.com/zloirock/core-js/issues/86#issuecomment-115759028
var global$f =
  // eslint-disable-next-line es-x/no-global-this -- safe
  check(typeof globalThis == 'object' && globalThis) ||
  check(typeof window == 'object' && window) ||
  // eslint-disable-next-line no-restricted-globals -- safe
  check(typeof self == 'object' && self) ||
  check(typeof commonjsGlobal == 'object' && commonjsGlobal) ||
  // eslint-disable-next-line no-new-func -- fallback
  (function () { return this; })() || Function('return this')();

var objectGetOwnPropertyDescriptor = {};

var fails$j = function (exec) {
  try {
    return !!exec();
  } catch (error) {
    return true;
  }
};

var fails$i = fails$j;

// Detect IE8's incomplete defineProperty implementation
var descriptors = !fails$i(function () {
  // eslint-disable-next-line es-x/no-object-defineproperty -- required for testing
  return Object.defineProperty({}, 1, { get: function () { return 7; } })[1] != 7;
});

var fails$h = fails$j;

var functionBindNative = !fails$h(function () {
  // eslint-disable-next-line es-x/no-function-prototype-bind -- safe
  var test = (function () { /* empty */ }).bind();
  // eslint-disable-next-line no-prototype-builtins -- safe
  return typeof test != 'function' || test.hasOwnProperty('prototype');
});

var NATIVE_BIND$2 = functionBindNative;

var call$b = Function.prototype.call;

var functionCall = NATIVE_BIND$2 ? call$b.bind(call$b) : function () {
  return call$b.apply(call$b, arguments);
};

var objectPropertyIsEnumerable = {};

var $propertyIsEnumerable = {}.propertyIsEnumerable;
// eslint-disable-next-line es-x/no-object-getownpropertydescriptor -- safe
var getOwnPropertyDescriptor$1 = Object.getOwnPropertyDescriptor;

// Nashorn ~ JDK8 bug
var NASHORN_BUG = getOwnPropertyDescriptor$1 && !$propertyIsEnumerable.call({ 1: 2 }, 1);

// `Object.prototype.propertyIsEnumerable` method implementation
// https://tc39.es/ecma262/#sec-object.prototype.propertyisenumerable
objectPropertyIsEnumerable.f = NASHORN_BUG ? function propertyIsEnumerable(V) {
  var descriptor = getOwnPropertyDescriptor$1(this, V);
  return !!descriptor && descriptor.enumerable;
} : $propertyIsEnumerable;

var createPropertyDescriptor$4 = function (bitmap, value) {
  return {
    enumerable: !(bitmap & 1),
    configurable: !(bitmap & 2),
    writable: !(bitmap & 4),
    value: value
  };
};

var NATIVE_BIND$1 = functionBindNative;

var FunctionPrototype$2 = Function.prototype;
var bind = FunctionPrototype$2.bind;
var call$a = FunctionPrototype$2.call;
var uncurryThis$j = NATIVE_BIND$1 && bind.bind(call$a, call$a);

var functionUncurryThis = NATIVE_BIND$1 ? function (fn) {
  return fn && uncurryThis$j(fn);
} : function (fn) {
  return fn && function () {
    return call$a.apply(fn, arguments);
  };
};

var uncurryThis$i = functionUncurryThis;

var toString$9 = uncurryThis$i({}.toString);
var stringSlice$4 = uncurryThis$i(''.slice);

var classofRaw$1 = function (it) {
  return stringSlice$4(toString$9(it), 8, -1);
};

var uncurryThis$h = functionUncurryThis;
var fails$g = fails$j;
var classof$5 = classofRaw$1;

var $Object$4 = Object;
var split = uncurryThis$h(''.split);

// fallback for non-array-like ES3 and non-enumerable old V8 strings
var indexedObject = fails$g(function () {
  // throws an error in rhino, see https://github.com/mozilla/rhino/issues/346
  // eslint-disable-next-line no-prototype-builtins -- safe
  return !$Object$4('z').propertyIsEnumerable(0);
}) ? function (it) {
  return classof$5(it) == 'String' ? split(it, '') : $Object$4(it);
} : $Object$4;

var $TypeError$8 = TypeError;

// `RequireObjectCoercible` abstract operation
// https://tc39.es/ecma262/#sec-requireobjectcoercible
var requireObjectCoercible$7 = function (it) {
  if (it == undefined) throw $TypeError$8("Can't call method on " + it);
  return it;
};

// toObject with fallback for non-array-like ES3 strings
var IndexedObject$1 = indexedObject;
var requireObjectCoercible$6 = requireObjectCoercible$7;

var toIndexedObject$5 = function (it) {
  return IndexedObject$1(requireObjectCoercible$6(it));
};

// `IsCallable` abstract operation
// https://tc39.es/ecma262/#sec-iscallable
var isCallable$h = function (argument) {
  return typeof argument == 'function';
};

var isCallable$g = isCallable$h;

var isObject$6 = function (it) {
  return typeof it == 'object' ? it !== null : isCallable$g(it);
};

var global$e = global$f;
var isCallable$f = isCallable$h;

var aFunction = function (argument) {
  return isCallable$f(argument) ? argument : undefined;
};

var getBuiltIn$5 = function (namespace, method) {
  return arguments.length < 2 ? aFunction(global$e[namespace]) : global$e[namespace] && global$e[namespace][method];
};

var uncurryThis$g = functionUncurryThis;

var objectIsPrototypeOf = uncurryThis$g({}.isPrototypeOf);

var getBuiltIn$4 = getBuiltIn$5;

var engineUserAgent = getBuiltIn$4('navigator', 'userAgent') || '';

var global$d = global$f;
var userAgent$1 = engineUserAgent;

var process = global$d.process;
var Deno = global$d.Deno;
var versions = process && process.versions || Deno && Deno.version;
var v8 = versions && versions.v8;
var match, version;

if (v8) {
  match = v8.split('.');
  // in old Chrome, versions of V8 isn't V8 = Chrome / 10
  // but their correct versions are not interesting for us
  version = match[0] > 0 && match[0] < 4 ? 1 : +(match[0] + match[1]);
}

// BrowserFS NodeJS `process` polyfill incorrectly set `.v8` to `0.0`
// so check `userAgent` even if `.v8` exists, but 0
if (!version && userAgent$1) {
  match = userAgent$1.match(/Edge\/(\d+)/);
  if (!match || match[1] >= 74) {
    match = userAgent$1.match(/Chrome\/(\d+)/);
    if (match) version = +match[1];
  }
}

var engineV8Version = version;

/* eslint-disable es-x/no-symbol -- required for testing */

var V8_VERSION = engineV8Version;
var fails$f = fails$j;

// eslint-disable-next-line es-x/no-object-getownpropertysymbols -- required for testing
var nativeSymbol = !!Object.getOwnPropertySymbols && !fails$f(function () {
  var symbol = Symbol();
  // Chrome 38 Symbol has incorrect toString conversion
  // `get-own-property-symbols` polyfill symbols converted to object are not Symbol instances
  return !String(symbol) || !(Object(symbol) instanceof Symbol) ||
    // Chrome 38-40 symbols are not inherited from DOM collections prototypes to instances
    !Symbol.sham && V8_VERSION && V8_VERSION < 41;
});

/* eslint-disable es-x/no-symbol -- required for testing */

var NATIVE_SYMBOL$1 = nativeSymbol;

var useSymbolAsUid = NATIVE_SYMBOL$1
  && !Symbol.sham
  && typeof Symbol.iterator == 'symbol';

var getBuiltIn$3 = getBuiltIn$5;
var isCallable$e = isCallable$h;
var isPrototypeOf$1 = objectIsPrototypeOf;
var USE_SYMBOL_AS_UID$1 = useSymbolAsUid;

var $Object$3 = Object;

var isSymbol$2 = USE_SYMBOL_AS_UID$1 ? function (it) {
  return typeof it == 'symbol';
} : function (it) {
  var $Symbol = getBuiltIn$3('Symbol');
  return isCallable$e($Symbol) && isPrototypeOf$1($Symbol.prototype, $Object$3(it));
};

var $String$3 = String;

var tryToString$2 = function (argument) {
  try {
    return $String$3(argument);
  } catch (error) {
    return 'Object';
  }
};

var isCallable$d = isCallable$h;
var tryToString$1 = tryToString$2;

var $TypeError$7 = TypeError;

// `Assert: IsCallable(argument) is true`
var aCallable$1 = function (argument) {
  if (isCallable$d(argument)) return argument;
  throw $TypeError$7(tryToString$1(argument) + ' is not a function');
};

var aCallable = aCallable$1;

// `GetMethod` abstract operation
// https://tc39.es/ecma262/#sec-getmethod
var getMethod$2 = function (V, P) {
  var func = V[P];
  return func == null ? undefined : aCallable(func);
};

var call$9 = functionCall;
var isCallable$c = isCallable$h;
var isObject$5 = isObject$6;

var $TypeError$6 = TypeError;

// `OrdinaryToPrimitive` abstract operation
// https://tc39.es/ecma262/#sec-ordinarytoprimitive
var ordinaryToPrimitive$1 = function (input, pref) {
  var fn, val;
  if (pref === 'string' && isCallable$c(fn = input.toString) && !isObject$5(val = call$9(fn, input))) return val;
  if (isCallable$c(fn = input.valueOf) && !isObject$5(val = call$9(fn, input))) return val;
  if (pref !== 'string' && isCallable$c(fn = input.toString) && !isObject$5(val = call$9(fn, input))) return val;
  throw $TypeError$6("Can't convert object to primitive value");
};

var shared$4 = {exports: {}};

var global$c = global$f;

// eslint-disable-next-line es-x/no-object-defineproperty -- safe
var defineProperty$5 = Object.defineProperty;

var defineGlobalProperty$3 = function (key, value) {
  try {
    defineProperty$5(global$c, key, { value: value, configurable: true, writable: true });
  } catch (error) {
    global$c[key] = value;
  } return value;
};

var global$b = global$f;
var defineGlobalProperty$2 = defineGlobalProperty$3;

var SHARED = '__core-js_shared__';
var store$3 = global$b[SHARED] || defineGlobalProperty$2(SHARED, {});

var sharedStore = store$3;

var store$2 = sharedStore;

(shared$4.exports = function (key, value) {
  return store$2[key] || (store$2[key] = value !== undefined ? value : {});
})('versions', []).push({
  version: '3.24.0',
  mode: 'global',
  copyright: '© 2014-2022 Denis Pushkarev (zloirock.ru)',
  license: 'https://github.com/zloirock/core-js/blob/v3.24.0/LICENSE',
  source: 'https://github.com/zloirock/core-js'
});

var requireObjectCoercible$5 = requireObjectCoercible$7;

var $Object$2 = Object;

// `ToObject` abstract operation
// https://tc39.es/ecma262/#sec-toobject
var toObject$3 = function (argument) {
  return $Object$2(requireObjectCoercible$5(argument));
};

var uncurryThis$f = functionUncurryThis;
var toObject$2 = toObject$3;

var hasOwnProperty = uncurryThis$f({}.hasOwnProperty);

// `HasOwnProperty` abstract operation
// https://tc39.es/ecma262/#sec-hasownproperty
// eslint-disable-next-line es-x/no-object-hasown -- safe
var hasOwnProperty_1 = Object.hasOwn || function hasOwn(it, key) {
  return hasOwnProperty(toObject$2(it), key);
};

var uncurryThis$e = functionUncurryThis;

var id = 0;
var postfix = Math.random();
var toString$8 = uncurryThis$e(1.0.toString);

var uid$2 = function (key) {
  return 'Symbol(' + (key === undefined ? '' : key) + ')_' + toString$8(++id + postfix, 36);
};

var global$a = global$f;
var shared$3 = shared$4.exports;
var hasOwn$9 = hasOwnProperty_1;
var uid$1 = uid$2;
var NATIVE_SYMBOL = nativeSymbol;
var USE_SYMBOL_AS_UID = useSymbolAsUid;

var WellKnownSymbolsStore = shared$3('wks');
var Symbol$2 = global$a.Symbol;
var symbolFor = Symbol$2 && Symbol$2['for'];
var createWellKnownSymbol = USE_SYMBOL_AS_UID ? Symbol$2 : Symbol$2 && Symbol$2.withoutSetter || uid$1;

var wellKnownSymbol$b = function (name) {
  if (!hasOwn$9(WellKnownSymbolsStore, name) || !(NATIVE_SYMBOL || typeof WellKnownSymbolsStore[name] == 'string')) {
    var description = 'Symbol.' + name;
    if (NATIVE_SYMBOL && hasOwn$9(Symbol$2, name)) {
      WellKnownSymbolsStore[name] = Symbol$2[name];
    } else if (USE_SYMBOL_AS_UID && symbolFor) {
      WellKnownSymbolsStore[name] = symbolFor(description);
    } else {
      WellKnownSymbolsStore[name] = createWellKnownSymbol(description);
    }
  } return WellKnownSymbolsStore[name];
};

var call$8 = functionCall;
var isObject$4 = isObject$6;
var isSymbol$1 = isSymbol$2;
var getMethod$1 = getMethod$2;
var ordinaryToPrimitive = ordinaryToPrimitive$1;
var wellKnownSymbol$a = wellKnownSymbol$b;

var $TypeError$5 = TypeError;
var TO_PRIMITIVE = wellKnownSymbol$a('toPrimitive');

// `ToPrimitive` abstract operation
// https://tc39.es/ecma262/#sec-toprimitive
var toPrimitive$1 = function (input, pref) {
  if (!isObject$4(input) || isSymbol$1(input)) return input;
  var exoticToPrim = getMethod$1(input, TO_PRIMITIVE);
  var result;
  if (exoticToPrim) {
    if (pref === undefined) pref = 'default';
    result = call$8(exoticToPrim, input, pref);
    if (!isObject$4(result) || isSymbol$1(result)) return result;
    throw $TypeError$5("Can't convert object to primitive value");
  }
  if (pref === undefined) pref = 'number';
  return ordinaryToPrimitive(input, pref);
};

var toPrimitive = toPrimitive$1;
var isSymbol = isSymbol$2;

// `ToPropertyKey` abstract operation
// https://tc39.es/ecma262/#sec-topropertykey
var toPropertyKey$3 = function (argument) {
  var key = toPrimitive(argument, 'string');
  return isSymbol(key) ? key : key + '';
};

var global$9 = global$f;
var isObject$3 = isObject$6;

var document$1 = global$9.document;
// typeof document.createElement is 'object' in old IE
var EXISTS$1 = isObject$3(document$1) && isObject$3(document$1.createElement);

var documentCreateElement$2 = function (it) {
  return EXISTS$1 ? document$1.createElement(it) : {};
};

var DESCRIPTORS$9 = descriptors;
var fails$e = fails$j;
var createElement = documentCreateElement$2;

// Thanks to IE8 for its funny defineProperty
var ie8DomDefine = !DESCRIPTORS$9 && !fails$e(function () {
  // eslint-disable-next-line es-x/no-object-defineproperty -- required for testing
  return Object.defineProperty(createElement('div'), 'a', {
    get: function () { return 7; }
  }).a != 7;
});

var DESCRIPTORS$8 = descriptors;
var call$7 = functionCall;
var propertyIsEnumerableModule$1 = objectPropertyIsEnumerable;
var createPropertyDescriptor$3 = createPropertyDescriptor$4;
var toIndexedObject$4 = toIndexedObject$5;
var toPropertyKey$2 = toPropertyKey$3;
var hasOwn$8 = hasOwnProperty_1;
var IE8_DOM_DEFINE$1 = ie8DomDefine;

// eslint-disable-next-line es-x/no-object-getownpropertydescriptor -- safe
var $getOwnPropertyDescriptor$1 = Object.getOwnPropertyDescriptor;

// `Object.getOwnPropertyDescriptor` method
// https://tc39.es/ecma262/#sec-object.getownpropertydescriptor
objectGetOwnPropertyDescriptor.f = DESCRIPTORS$8 ? $getOwnPropertyDescriptor$1 : function getOwnPropertyDescriptor(O, P) {
  O = toIndexedObject$4(O);
  P = toPropertyKey$2(P);
  if (IE8_DOM_DEFINE$1) try {
    return $getOwnPropertyDescriptor$1(O, P);
  } catch (error) { /* empty */ }
  if (hasOwn$8(O, P)) return createPropertyDescriptor$3(!call$7(propertyIsEnumerableModule$1.f, O, P), O[P]);
};

var objectDefineProperty = {};

var DESCRIPTORS$7 = descriptors;
var fails$d = fails$j;

// V8 ~ Chrome 36-
// https://bugs.chromium.org/p/v8/issues/detail?id=3334
var v8PrototypeDefineBug = DESCRIPTORS$7 && fails$d(function () {
  // eslint-disable-next-line es-x/no-object-defineproperty -- required for testing
  return Object.defineProperty(function () { /* empty */ }, 'prototype', {
    value: 42,
    writable: false
  }).prototype != 42;
});

var isObject$2 = isObject$6;

var $String$2 = String;
var $TypeError$4 = TypeError;

// `Assert: Type(argument) is Object`
var anObject$a = function (argument) {
  if (isObject$2(argument)) return argument;
  throw $TypeError$4($String$2(argument) + ' is not an object');
};

var DESCRIPTORS$6 = descriptors;
var IE8_DOM_DEFINE = ie8DomDefine;
var V8_PROTOTYPE_DEFINE_BUG$1 = v8PrototypeDefineBug;
var anObject$9 = anObject$a;
var toPropertyKey$1 = toPropertyKey$3;

var $TypeError$3 = TypeError;
// eslint-disable-next-line es-x/no-object-defineproperty -- safe
var $defineProperty = Object.defineProperty;
// eslint-disable-next-line es-x/no-object-getownpropertydescriptor -- safe
var $getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var ENUMERABLE = 'enumerable';
var CONFIGURABLE$1 = 'configurable';
var WRITABLE = 'writable';

// `Object.defineProperty` method
// https://tc39.es/ecma262/#sec-object.defineproperty
objectDefineProperty.f = DESCRIPTORS$6 ? V8_PROTOTYPE_DEFINE_BUG$1 ? function defineProperty(O, P, Attributes) {
  anObject$9(O);
  P = toPropertyKey$1(P);
  anObject$9(Attributes);
  if (typeof O === 'function' && P === 'prototype' && 'value' in Attributes && WRITABLE in Attributes && !Attributes[WRITABLE]) {
    var current = $getOwnPropertyDescriptor(O, P);
    if (current && current[WRITABLE]) {
      O[P] = Attributes.value;
      Attributes = {
        configurable: CONFIGURABLE$1 in Attributes ? Attributes[CONFIGURABLE$1] : current[CONFIGURABLE$1],
        enumerable: ENUMERABLE in Attributes ? Attributes[ENUMERABLE] : current[ENUMERABLE],
        writable: false
      };
    }
  } return $defineProperty(O, P, Attributes);
} : $defineProperty : function defineProperty(O, P, Attributes) {
  anObject$9(O);
  P = toPropertyKey$1(P);
  anObject$9(Attributes);
  if (IE8_DOM_DEFINE) try {
    return $defineProperty(O, P, Attributes);
  } catch (error) { /* empty */ }
  if ('get' in Attributes || 'set' in Attributes) throw $TypeError$3('Accessors not supported');
  if ('value' in Attributes) O[P] = Attributes.value;
  return O;
};

var DESCRIPTORS$5 = descriptors;
var definePropertyModule$4 = objectDefineProperty;
var createPropertyDescriptor$2 = createPropertyDescriptor$4;

var createNonEnumerableProperty$5 = DESCRIPTORS$5 ? function (object, key, value) {
  return definePropertyModule$4.f(object, key, createPropertyDescriptor$2(1, value));
} : function (object, key, value) {
  object[key] = value;
  return object;
};

var makeBuiltIn$2 = {exports: {}};

var DESCRIPTORS$4 = descriptors;
var hasOwn$7 = hasOwnProperty_1;

var FunctionPrototype$1 = Function.prototype;
// eslint-disable-next-line es-x/no-object-getownpropertydescriptor -- safe
var getDescriptor = DESCRIPTORS$4 && Object.getOwnPropertyDescriptor;

var EXISTS = hasOwn$7(FunctionPrototype$1, 'name');
// additional protection from minified / mangled / dropped function names
var PROPER = EXISTS && (function something() { /* empty */ }).name === 'something';
var CONFIGURABLE = EXISTS && (!DESCRIPTORS$4 || (DESCRIPTORS$4 && getDescriptor(FunctionPrototype$1, 'name').configurable));

var functionName = {
  EXISTS: EXISTS,
  PROPER: PROPER,
  CONFIGURABLE: CONFIGURABLE
};

var uncurryThis$d = functionUncurryThis;
var isCallable$b = isCallable$h;
var store$1 = sharedStore;

var functionToString = uncurryThis$d(Function.toString);

// this helper broken in `core-js@3.4.1-3.4.4`, so we can't use `shared` helper
if (!isCallable$b(store$1.inspectSource)) {
  store$1.inspectSource = function (it) {
    return functionToString(it);
  };
}

var inspectSource$3 = store$1.inspectSource;

var global$8 = global$f;
var isCallable$a = isCallable$h;
var inspectSource$2 = inspectSource$3;

var WeakMap$1 = global$8.WeakMap;

var nativeWeakMap = isCallable$a(WeakMap$1) && /native code/.test(inspectSource$2(WeakMap$1));

var shared$2 = shared$4.exports;
var uid = uid$2;

var keys = shared$2('keys');

var sharedKey$3 = function (key) {
  return keys[key] || (keys[key] = uid(key));
};

var hiddenKeys$4 = {};

var NATIVE_WEAK_MAP = nativeWeakMap;
var global$7 = global$f;
var uncurryThis$c = functionUncurryThis;
var isObject$1 = isObject$6;
var createNonEnumerableProperty$4 = createNonEnumerableProperty$5;
var hasOwn$6 = hasOwnProperty_1;
var shared$1 = sharedStore;
var sharedKey$2 = sharedKey$3;
var hiddenKeys$3 = hiddenKeys$4;

var OBJECT_ALREADY_INITIALIZED = 'Object already initialized';
var TypeError$1 = global$7.TypeError;
var WeakMap = global$7.WeakMap;
var set, get, has;

var enforce = function (it) {
  return has(it) ? get(it) : set(it, {});
};

var getterFor = function (TYPE) {
  return function (it) {
    var state;
    if (!isObject$1(it) || (state = get(it)).type !== TYPE) {
      throw TypeError$1('Incompatible receiver, ' + TYPE + ' required');
    } return state;
  };
};

if (NATIVE_WEAK_MAP || shared$1.state) {
  var store = shared$1.state || (shared$1.state = new WeakMap());
  var wmget = uncurryThis$c(store.get);
  var wmhas = uncurryThis$c(store.has);
  var wmset = uncurryThis$c(store.set);
  set = function (it, metadata) {
    if (wmhas(store, it)) throw new TypeError$1(OBJECT_ALREADY_INITIALIZED);
    metadata.facade = it;
    wmset(store, it, metadata);
    return metadata;
  };
  get = function (it) {
    return wmget(store, it) || {};
  };
  has = function (it) {
    return wmhas(store, it);
  };
} else {
  var STATE = sharedKey$2('state');
  hiddenKeys$3[STATE] = true;
  set = function (it, metadata) {
    if (hasOwn$6(it, STATE)) throw new TypeError$1(OBJECT_ALREADY_INITIALIZED);
    metadata.facade = it;
    createNonEnumerableProperty$4(it, STATE, metadata);
    return metadata;
  };
  get = function (it) {
    return hasOwn$6(it, STATE) ? it[STATE] : {};
  };
  has = function (it) {
    return hasOwn$6(it, STATE);
  };
}

var internalState = {
  set: set,
  get: get,
  has: has,
  enforce: enforce,
  getterFor: getterFor
};

var fails$c = fails$j;
var isCallable$9 = isCallable$h;
var hasOwn$5 = hasOwnProperty_1;
var DESCRIPTORS$3 = descriptors;
var CONFIGURABLE_FUNCTION_NAME$1 = functionName.CONFIGURABLE;
var inspectSource$1 = inspectSource$3;
var InternalStateModule$1 = internalState;

var enforceInternalState = InternalStateModule$1.enforce;
var getInternalState$2 = InternalStateModule$1.get;
// eslint-disable-next-line es-x/no-object-defineproperty -- safe
var defineProperty$4 = Object.defineProperty;

var CONFIGURABLE_LENGTH = DESCRIPTORS$3 && !fails$c(function () {
  return defineProperty$4(function () { /* empty */ }, 'length', { value: 8 }).length !== 8;
});

var TEMPLATE = String(String).split('String');

var makeBuiltIn$1 = makeBuiltIn$2.exports = function (value, name, options) {
  if (String(name).slice(0, 7) === 'Symbol(') {
    name = '[' + String(name).replace(/^Symbol\(([^)]*)\)/, '$1') + ']';
  }
  if (options && options.getter) name = 'get ' + name;
  if (options && options.setter) name = 'set ' + name;
  if (!hasOwn$5(value, 'name') || (CONFIGURABLE_FUNCTION_NAME$1 && value.name !== name)) {
    if (DESCRIPTORS$3) defineProperty$4(value, 'name', { value: name, configurable: true });
    else value.name = name;
  }
  if (CONFIGURABLE_LENGTH && options && hasOwn$5(options, 'arity') && value.length !== options.arity) {
    defineProperty$4(value, 'length', { value: options.arity });
  }
  try {
    if (options && hasOwn$5(options, 'constructor') && options.constructor) {
      if (DESCRIPTORS$3) defineProperty$4(value, 'prototype', { writable: false });
    // in V8 ~ Chrome 53, prototypes of some methods, like `Array.prototype.values`, are non-writable
    } else if (value.prototype) value.prototype = undefined;
  } catch (error) { /* empty */ }
  var state = enforceInternalState(value);
  if (!hasOwn$5(state, 'source')) {
    state.source = TEMPLATE.join(typeof name == 'string' ? name : '');
  } return value;
};

// add fake Function#toString for correct work wrapped methods / constructors with methods like LoDash isNative
// eslint-disable-next-line no-extend-native -- required
Function.prototype.toString = makeBuiltIn$1(function toString() {
  return isCallable$9(this) && getInternalState$2(this).source || inspectSource$1(this);
}, 'toString');

var isCallable$8 = isCallable$h;
var definePropertyModule$3 = objectDefineProperty;
var makeBuiltIn = makeBuiltIn$2.exports;
var defineGlobalProperty$1 = defineGlobalProperty$3;

var defineBuiltIn$5 = function (O, key, value, options) {
  if (!options) options = {};
  var simple = options.enumerable;
  var name = options.name !== undefined ? options.name : key;
  if (isCallable$8(value)) makeBuiltIn(value, name, options);
  if (options.global) {
    if (simple) O[key] = value;
    else defineGlobalProperty$1(key, value);
  } else {
    try {
      if (!options.unsafe) delete O[key];
      else if (O[key]) simple = true;
    } catch (error) { /* empty */ }
    if (simple) O[key] = value;
    else definePropertyModule$3.f(O, key, {
      value: value,
      enumerable: false,
      configurable: !options.nonConfigurable,
      writable: !options.nonWritable
    });
  } return O;
};

var objectGetOwnPropertyNames = {};

var ceil$1 = Math.ceil;
var floor = Math.floor;

// `Math.trunc` method
// https://tc39.es/ecma262/#sec-math.trunc
// eslint-disable-next-line es-x/no-math-trunc -- safe
var mathTrunc = Math.trunc || function trunc(x) {
  var n = +x;
  return (n > 0 ? floor : ceil$1)(n);
};

var trunc = mathTrunc;

// `ToIntegerOrInfinity` abstract operation
// https://tc39.es/ecma262/#sec-tointegerorinfinity
var toIntegerOrInfinity$4 = function (argument) {
  var number = +argument;
  // eslint-disable-next-line no-self-compare -- NaN check
  return number !== number || number === 0 ? 0 : trunc(number);
};

var toIntegerOrInfinity$3 = toIntegerOrInfinity$4;

var max$1 = Math.max;
var min$2 = Math.min;

// Helper for a popular repeating case of the spec:
// Let integer be ? ToInteger(index).
// If integer < 0, let result be max((length + integer), 0); else let result be min(integer, length).
var toAbsoluteIndex$2 = function (index, length) {
  var integer = toIntegerOrInfinity$3(index);
  return integer < 0 ? max$1(integer + length, 0) : min$2(integer, length);
};

var toIntegerOrInfinity$2 = toIntegerOrInfinity$4;

var min$1 = Math.min;

// `ToLength` abstract operation
// https://tc39.es/ecma262/#sec-tolength
var toLength$3 = function (argument) {
  return argument > 0 ? min$1(toIntegerOrInfinity$2(argument), 0x1FFFFFFFFFFFFF) : 0; // 2 ** 53 - 1 == 9007199254740991
};

var toLength$2 = toLength$3;

// `LengthOfArrayLike` abstract operation
// https://tc39.es/ecma262/#sec-lengthofarraylike
var lengthOfArrayLike$2 = function (obj) {
  return toLength$2(obj.length);
};

var toIndexedObject$3 = toIndexedObject$5;
var toAbsoluteIndex$1 = toAbsoluteIndex$2;
var lengthOfArrayLike$1 = lengthOfArrayLike$2;

// `Array.prototype.{ indexOf, includes }` methods implementation
var createMethod$3 = function (IS_INCLUDES) {
  return function ($this, el, fromIndex) {
    var O = toIndexedObject$3($this);
    var length = lengthOfArrayLike$1(O);
    var index = toAbsoluteIndex$1(fromIndex, length);
    var value;
    // Array#includes uses SameValueZero equality algorithm
    // eslint-disable-next-line no-self-compare -- NaN check
    if (IS_INCLUDES && el != el) while (length > index) {
      value = O[index++];
      // eslint-disable-next-line no-self-compare -- NaN check
      if (value != value) return true;
    // Array#indexOf ignores holes, Array#includes - not
    } else for (;length > index; index++) {
      if ((IS_INCLUDES || index in O) && O[index] === el) return IS_INCLUDES || index || 0;
    } return !IS_INCLUDES && -1;
  };
};

var arrayIncludes = {
  // `Array.prototype.includes` method
  // https://tc39.es/ecma262/#sec-array.prototype.includes
  includes: createMethod$3(true),
  // `Array.prototype.indexOf` method
  // https://tc39.es/ecma262/#sec-array.prototype.indexof
  indexOf: createMethod$3(false)
};

var uncurryThis$b = functionUncurryThis;
var hasOwn$4 = hasOwnProperty_1;
var toIndexedObject$2 = toIndexedObject$5;
var indexOf$1 = arrayIncludes.indexOf;
var hiddenKeys$2 = hiddenKeys$4;

var push$1 = uncurryThis$b([].push);

var objectKeysInternal = function (object, names) {
  var O = toIndexedObject$2(object);
  var i = 0;
  var result = [];
  var key;
  for (key in O) !hasOwn$4(hiddenKeys$2, key) && hasOwn$4(O, key) && push$1(result, key);
  // Don't enum bug & hidden keys
  while (names.length > i) if (hasOwn$4(O, key = names[i++])) {
    ~indexOf$1(result, key) || push$1(result, key);
  }
  return result;
};

// IE8- don't enum bug keys
var enumBugKeys$3 = [
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf'
];

var internalObjectKeys$1 = objectKeysInternal;
var enumBugKeys$2 = enumBugKeys$3;

var hiddenKeys$1 = enumBugKeys$2.concat('length', 'prototype');

// `Object.getOwnPropertyNames` method
// https://tc39.es/ecma262/#sec-object.getownpropertynames
// eslint-disable-next-line es-x/no-object-getownpropertynames -- safe
objectGetOwnPropertyNames.f = Object.getOwnPropertyNames || function getOwnPropertyNames(O) {
  return internalObjectKeys$1(O, hiddenKeys$1);
};

var objectGetOwnPropertySymbols = {};

// eslint-disable-next-line es-x/no-object-getownpropertysymbols -- safe
objectGetOwnPropertySymbols.f = Object.getOwnPropertySymbols;

var getBuiltIn$2 = getBuiltIn$5;
var uncurryThis$a = functionUncurryThis;
var getOwnPropertyNamesModule = objectGetOwnPropertyNames;
var getOwnPropertySymbolsModule$1 = objectGetOwnPropertySymbols;
var anObject$8 = anObject$a;

var concat$1 = uncurryThis$a([].concat);

// all object keys, includes non-enumerable and symbols
var ownKeys$1 = getBuiltIn$2('Reflect', 'ownKeys') || function ownKeys(it) {
  var keys = getOwnPropertyNamesModule.f(anObject$8(it));
  var getOwnPropertySymbols = getOwnPropertySymbolsModule$1.f;
  return getOwnPropertySymbols ? concat$1(keys, getOwnPropertySymbols(it)) : keys;
};

var hasOwn$3 = hasOwnProperty_1;
var ownKeys = ownKeys$1;
var getOwnPropertyDescriptorModule = objectGetOwnPropertyDescriptor;
var definePropertyModule$2 = objectDefineProperty;

var copyConstructorProperties$1 = function (target, source, exceptions) {
  var keys = ownKeys(source);
  var defineProperty = definePropertyModule$2.f;
  var getOwnPropertyDescriptor = getOwnPropertyDescriptorModule.f;
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (!hasOwn$3(target, key) && !(exceptions && hasOwn$3(exceptions, key))) {
      defineProperty(target, key, getOwnPropertyDescriptor(source, key));
    }
  }
};

var fails$b = fails$j;
var isCallable$7 = isCallable$h;

var replacement = /#|\.prototype\./;

var isForced$1 = function (feature, detection) {
  var value = data[normalize(feature)];
  return value == POLYFILL ? true
    : value == NATIVE ? false
    : isCallable$7(detection) ? fails$b(detection)
    : !!detection;
};

var normalize = isForced$1.normalize = function (string) {
  return String(string).replace(replacement, '.').toLowerCase();
};

var data = isForced$1.data = {};
var NATIVE = isForced$1.NATIVE = 'N';
var POLYFILL = isForced$1.POLYFILL = 'P';

var isForced_1 = isForced$1;

var global$6 = global$f;
var getOwnPropertyDescriptor = objectGetOwnPropertyDescriptor.f;
var createNonEnumerableProperty$3 = createNonEnumerableProperty$5;
var defineBuiltIn$4 = defineBuiltIn$5;
var defineGlobalProperty = defineGlobalProperty$3;
var copyConstructorProperties = copyConstructorProperties$1;
var isForced = isForced_1;

/*
  options.target         - name of the target object
  options.global         - target is the global object
  options.stat           - export as static methods of target
  options.proto          - export as prototype methods of target
  options.real           - real prototype method for the `pure` version
  options.forced         - export even if the native feature is available
  options.bind           - bind methods to the target, required for the `pure` version
  options.wrap           - wrap constructors to preventing global pollution, required for the `pure` version
  options.unsafe         - use the simple assignment of property instead of delete + defineProperty
  options.sham           - add a flag to not completely full polyfills
  options.enumerable     - export as enumerable property
  options.dontCallGetSet - prevent calling a getter on target
  options.name           - the .name of the function if it does not match the key
*/
var _export = function (options, source) {
  var TARGET = options.target;
  var GLOBAL = options.global;
  var STATIC = options.stat;
  var FORCED, target, key, targetProperty, sourceProperty, descriptor;
  if (GLOBAL) {
    target = global$6;
  } else if (STATIC) {
    target = global$6[TARGET] || defineGlobalProperty(TARGET, {});
  } else {
    target = (global$6[TARGET] || {}).prototype;
  }
  if (target) for (key in source) {
    sourceProperty = source[key];
    if (options.dontCallGetSet) {
      descriptor = getOwnPropertyDescriptor(target, key);
      targetProperty = descriptor && descriptor.value;
    } else targetProperty = target[key];
    FORCED = isForced(GLOBAL ? key : TARGET + (STATIC ? '.' : '#') + key, options.forced);
    // contained in target
    if (!FORCED && targetProperty !== undefined) {
      if (typeof sourceProperty == typeof targetProperty) continue;
      copyConstructorProperties(sourceProperty, targetProperty);
    }
    // add a flag to not completely full polyfills
    if (options.sham || (targetProperty && targetProperty.sham)) {
      createNonEnumerableProperty$3(sourceProperty, 'sham', true);
    }
    defineBuiltIn$4(target, key, sourceProperty, options);
  }
};

var wellKnownSymbol$9 = wellKnownSymbol$b;

var TO_STRING_TAG$3 = wellKnownSymbol$9('toStringTag');
var test = {};

test[TO_STRING_TAG$3] = 'z';

var toStringTagSupport = String(test) === '[object z]';

var TO_STRING_TAG_SUPPORT = toStringTagSupport;
var isCallable$6 = isCallable$h;
var classofRaw = classofRaw$1;
var wellKnownSymbol$8 = wellKnownSymbol$b;

var TO_STRING_TAG$2 = wellKnownSymbol$8('toStringTag');
var $Object$1 = Object;

// ES3 wrong here
var CORRECT_ARGUMENTS = classofRaw(function () { return arguments; }()) == 'Arguments';

// fallback for IE11 Script Access Denied error
var tryGet = function (it, key) {
  try {
    return it[key];
  } catch (error) { /* empty */ }
};

// getting tag from ES6+ `Object.prototype.toString`
var classof$4 = TO_STRING_TAG_SUPPORT ? classofRaw : function (it) {
  var O, tag, result;
  return it === undefined ? 'Undefined' : it === null ? 'Null'
    // @@toStringTag case
    : typeof (tag = tryGet(O = $Object$1(it), TO_STRING_TAG$2)) == 'string' ? tag
    // builtinTag case
    : CORRECT_ARGUMENTS ? classofRaw(O)
    // ES3 arguments fallback
    : (result = classofRaw(O)) == 'Object' && isCallable$6(O.callee) ? 'Arguments' : result;
};

var classof$3 = classof$4;

var $String$1 = String;

var toString$7 = function (argument) {
  if (classof$3(argument) === 'Symbol') throw TypeError('Cannot convert a Symbol value to a string');
  return $String$1(argument);
};

var anObject$7 = anObject$a;

// `RegExp.prototype.flags` getter implementation
// https://tc39.es/ecma262/#sec-get-regexp.prototype.flags
var regexpFlags$1 = function () {
  var that = anObject$7(this);
  var result = '';
  if (that.hasIndices) result += 'd';
  if (that.global) result += 'g';
  if (that.ignoreCase) result += 'i';
  if (that.multiline) result += 'm';
  if (that.dotAll) result += 's';
  if (that.unicode) result += 'u';
  if (that.unicodeSets) result += 'v';
  if (that.sticky) result += 'y';
  return result;
};

var fails$a = fails$j;
var global$5 = global$f;

// babel-minify and Closure Compiler transpiles RegExp('a', 'y') -> /a/y and it causes SyntaxError
var $RegExp$2 = global$5.RegExp;

var UNSUPPORTED_Y$2 = fails$a(function () {
  var re = $RegExp$2('a', 'y');
  re.lastIndex = 2;
  return re.exec('abcd') != null;
});

// UC Browser bug
// https://github.com/zloirock/core-js/issues/1008
var MISSED_STICKY = UNSUPPORTED_Y$2 || fails$a(function () {
  return !$RegExp$2('a', 'y').sticky;
});

var BROKEN_CARET = UNSUPPORTED_Y$2 || fails$a(function () {
  // https://bugzilla.mozilla.org/show_bug.cgi?id=773687
  var re = $RegExp$2('^r', 'gy');
  re.lastIndex = 2;
  return re.exec('str') != null;
});

var regexpStickyHelpers = {
  BROKEN_CARET: BROKEN_CARET,
  MISSED_STICKY: MISSED_STICKY,
  UNSUPPORTED_Y: UNSUPPORTED_Y$2
};

var objectDefineProperties = {};

var internalObjectKeys = objectKeysInternal;
var enumBugKeys$1 = enumBugKeys$3;

// `Object.keys` method
// https://tc39.es/ecma262/#sec-object.keys
// eslint-disable-next-line es-x/no-object-keys -- safe
var objectKeys$2 = Object.keys || function keys(O) {
  return internalObjectKeys(O, enumBugKeys$1);
};

var DESCRIPTORS$2 = descriptors;
var V8_PROTOTYPE_DEFINE_BUG = v8PrototypeDefineBug;
var definePropertyModule$1 = objectDefineProperty;
var anObject$6 = anObject$a;
var toIndexedObject$1 = toIndexedObject$5;
var objectKeys$1 = objectKeys$2;

// `Object.defineProperties` method
// https://tc39.es/ecma262/#sec-object.defineproperties
// eslint-disable-next-line es-x/no-object-defineproperties -- safe
objectDefineProperties.f = DESCRIPTORS$2 && !V8_PROTOTYPE_DEFINE_BUG ? Object.defineProperties : function defineProperties(O, Properties) {
  anObject$6(O);
  var props = toIndexedObject$1(Properties);
  var keys = objectKeys$1(Properties);
  var length = keys.length;
  var index = 0;
  var key;
  while (length > index) definePropertyModule$1.f(O, key = keys[index++], props[key]);
  return O;
};

var getBuiltIn$1 = getBuiltIn$5;

var html$1 = getBuiltIn$1('document', 'documentElement');

/* global ActiveXObject -- old IE, WSH */

var anObject$5 = anObject$a;
var definePropertiesModule = objectDefineProperties;
var enumBugKeys = enumBugKeys$3;
var hiddenKeys = hiddenKeys$4;
var html = html$1;
var documentCreateElement$1 = documentCreateElement$2;
var sharedKey$1 = sharedKey$3;

var GT = '>';
var LT = '<';
var PROTOTYPE = 'prototype';
var SCRIPT = 'script';
var IE_PROTO$1 = sharedKey$1('IE_PROTO');

var EmptyConstructor = function () { /* empty */ };

var scriptTag = function (content) {
  return LT + SCRIPT + GT + content + LT + '/' + SCRIPT + GT;
};

// Create object with fake `null` prototype: use ActiveX Object with cleared prototype
var NullProtoObjectViaActiveX = function (activeXDocument) {
  activeXDocument.write(scriptTag(''));
  activeXDocument.close();
  var temp = activeXDocument.parentWindow.Object;
  activeXDocument = null; // avoid memory leak
  return temp;
};

// Create object with fake `null` prototype: use iframe Object with cleared prototype
var NullProtoObjectViaIFrame = function () {
  // Thrash, waste and sodomy: IE GC bug
  var iframe = documentCreateElement$1('iframe');
  var JS = 'java' + SCRIPT + ':';
  var iframeDocument;
  iframe.style.display = 'none';
  html.appendChild(iframe);
  // https://github.com/zloirock/core-js/issues/475
  iframe.src = String(JS);
  iframeDocument = iframe.contentWindow.document;
  iframeDocument.open();
  iframeDocument.write(scriptTag('document.F=Object'));
  iframeDocument.close();
  return iframeDocument.F;
};

// Check for document.domain and active x support
// No need to use active x approach when document.domain is not set
// see https://github.com/es-shims/es5-shim/issues/150
// variation of https://github.com/kitcambridge/es5-shim/commit/4f738ac066346
// avoid IE GC bug
var activeXDocument;
var NullProtoObject = function () {
  try {
    activeXDocument = new ActiveXObject('htmlfile');
  } catch (error) { /* ignore */ }
  NullProtoObject = typeof document != 'undefined'
    ? document.domain && activeXDocument
      ? NullProtoObjectViaActiveX(activeXDocument) // old IE
      : NullProtoObjectViaIFrame()
    : NullProtoObjectViaActiveX(activeXDocument); // WSH
  var length = enumBugKeys.length;
  while (length--) delete NullProtoObject[PROTOTYPE][enumBugKeys[length]];
  return NullProtoObject();
};

hiddenKeys[IE_PROTO$1] = true;

// `Object.create` method
// https://tc39.es/ecma262/#sec-object.create
// eslint-disable-next-line es-x/no-object-create -- safe
var objectCreate = Object.create || function create(O, Properties) {
  var result;
  if (O !== null) {
    EmptyConstructor[PROTOTYPE] = anObject$5(O);
    result = new EmptyConstructor();
    EmptyConstructor[PROTOTYPE] = null;
    // add "__proto__" for Object.getPrototypeOf polyfill
    result[IE_PROTO$1] = O;
  } else result = NullProtoObject();
  return Properties === undefined ? result : definePropertiesModule.f(result, Properties);
};

var fails$9 = fails$j;
var global$4 = global$f;

// babel-minify and Closure Compiler transpiles RegExp('.', 's') -> /./s and it causes SyntaxError
var $RegExp$1 = global$4.RegExp;

var regexpUnsupportedDotAll = fails$9(function () {
  var re = $RegExp$1('.', 's');
  return !(re.dotAll && re.exec('\n') && re.flags === 's');
});

var fails$8 = fails$j;
var global$3 = global$f;

// babel-minify and Closure Compiler transpiles RegExp('(?<a>b)', 'g') -> /(?<a>b)/g and it causes SyntaxError
var $RegExp = global$3.RegExp;

var regexpUnsupportedNcg = fails$8(function () {
  var re = $RegExp('(?<a>b)', 'g');
  return re.exec('b').groups.a !== 'b' ||
    'b'.replace(re, '$<a>c') !== 'bc';
});

/* eslint-disable regexp/no-empty-capturing-group, regexp/no-empty-group, regexp/no-lazy-ends -- testing */
/* eslint-disable regexp/no-useless-quantifier -- testing */
var call$6 = functionCall;
var uncurryThis$9 = functionUncurryThis;
var toString$6 = toString$7;
var regexpFlags = regexpFlags$1;
var stickyHelpers$1 = regexpStickyHelpers;
var shared = shared$4.exports;
var create$2 = objectCreate;
var getInternalState$1 = internalState.get;
var UNSUPPORTED_DOT_ALL = regexpUnsupportedDotAll;
var UNSUPPORTED_NCG = regexpUnsupportedNcg;

var nativeReplace = shared('native-string-replace', String.prototype.replace);
var nativeExec = RegExp.prototype.exec;
var patchedExec = nativeExec;
var charAt$2 = uncurryThis$9(''.charAt);
var indexOf = uncurryThis$9(''.indexOf);
var replace$1 = uncurryThis$9(''.replace);
var stringSlice$3 = uncurryThis$9(''.slice);

var UPDATES_LAST_INDEX_WRONG = (function () {
  var re1 = /a/;
  var re2 = /b*/g;
  call$6(nativeExec, re1, 'a');
  call$6(nativeExec, re2, 'a');
  return re1.lastIndex !== 0 || re2.lastIndex !== 0;
})();

var UNSUPPORTED_Y$1 = stickyHelpers$1.BROKEN_CARET;

// nonparticipating capturing group, copied from es5-shim's String#split patch.
var NPCG_INCLUDED = /()??/.exec('')[1] !== undefined;

var PATCH = UPDATES_LAST_INDEX_WRONG || NPCG_INCLUDED || UNSUPPORTED_Y$1 || UNSUPPORTED_DOT_ALL || UNSUPPORTED_NCG;

if (PATCH) {
  patchedExec = function exec(string) {
    var re = this;
    var state = getInternalState$1(re);
    var str = toString$6(string);
    var raw = state.raw;
    var result, reCopy, lastIndex, match, i, object, group;

    if (raw) {
      raw.lastIndex = re.lastIndex;
      result = call$6(patchedExec, raw, str);
      re.lastIndex = raw.lastIndex;
      return result;
    }

    var groups = state.groups;
    var sticky = UNSUPPORTED_Y$1 && re.sticky;
    var flags = call$6(regexpFlags, re);
    var source = re.source;
    var charsAdded = 0;
    var strCopy = str;

    if (sticky) {
      flags = replace$1(flags, 'y', '');
      if (indexOf(flags, 'g') === -1) {
        flags += 'g';
      }

      strCopy = stringSlice$3(str, re.lastIndex);
      // Support anchored sticky behavior.
      if (re.lastIndex > 0 && (!re.multiline || re.multiline && charAt$2(str, re.lastIndex - 1) !== '\n')) {
        source = '(?: ' + source + ')';
        strCopy = ' ' + strCopy;
        charsAdded++;
      }
      // ^(? + rx + ) is needed, in combination with some str slicing, to
      // simulate the 'y' flag.
      reCopy = new RegExp('^(?:' + source + ')', flags);
    }

    if (NPCG_INCLUDED) {
      reCopy = new RegExp('^' + source + '$(?!\\s)', flags);
    }
    if (UPDATES_LAST_INDEX_WRONG) lastIndex = re.lastIndex;

    match = call$6(nativeExec, sticky ? reCopy : re, strCopy);

    if (sticky) {
      if (match) {
        match.input = stringSlice$3(match.input, charsAdded);
        match[0] = stringSlice$3(match[0], charsAdded);
        match.index = re.lastIndex;
        re.lastIndex += match[0].length;
      } else re.lastIndex = 0;
    } else if (UPDATES_LAST_INDEX_WRONG && match) {
      re.lastIndex = re.global ? match.index + match[0].length : lastIndex;
    }
    if (NPCG_INCLUDED && match && match.length > 1) {
      // Fix browsers whose `exec` methods don't consistently return `undefined`
      // for NPCG, like IE8. NOTE: This doesn't work for /(.?)?/
      call$6(nativeReplace, match[0], reCopy, function () {
        for (i = 1; i < arguments.length - 2; i++) {
          if (arguments[i] === undefined) match[i] = undefined;
        }
      });
    }

    if (match && groups) {
      match.groups = object = create$2(null);
      for (i = 0; i < groups.length; i++) {
        group = groups[i];
        object[group[0]] = match[group[1]];
      }
    }

    return match;
  };
}

var regexpExec$3 = patchedExec;

var $$4 = _export;
var exec$3 = regexpExec$3;

// `RegExp.prototype.exec` method
// https://tc39.es/ecma262/#sec-regexp.prototype.exec
$$4({ target: 'RegExp', proto: true, forced: /./.exec !== exec$3 }, {
  exec: exec$3
});

var NATIVE_BIND = functionBindNative;

var FunctionPrototype = Function.prototype;
var apply$1 = FunctionPrototype.apply;
var call$5 = FunctionPrototype.call;

// eslint-disable-next-line es-x/no-reflect -- safe
var functionApply = typeof Reflect == 'object' && Reflect.apply || (NATIVE_BIND ? call$5.bind(apply$1) : function () {
  return call$5.apply(apply$1, arguments);
});

// TODO: Remove from `core-js@4` since it's moved to entry points

var uncurryThis$8 = functionUncurryThis;
var defineBuiltIn$3 = defineBuiltIn$5;
var regexpExec$2 = regexpExec$3;
var fails$7 = fails$j;
var wellKnownSymbol$7 = wellKnownSymbol$b;
var createNonEnumerableProperty$2 = createNonEnumerableProperty$5;

var SPECIES$1 = wellKnownSymbol$7('species');
var RegExpPrototype$2 = RegExp.prototype;

var fixRegexpWellKnownSymbolLogic = function (KEY, exec, FORCED, SHAM) {
  var SYMBOL = wellKnownSymbol$7(KEY);

  var DELEGATES_TO_SYMBOL = !fails$7(function () {
    // String methods call symbol-named RegEp methods
    var O = {};
    O[SYMBOL] = function () { return 7; };
    return ''[KEY](O) != 7;
  });

  var DELEGATES_TO_EXEC = DELEGATES_TO_SYMBOL && !fails$7(function () {
    // Symbol-named RegExp methods call .exec
    var execCalled = false;
    var re = /a/;

    if (KEY === 'split') {
      // We can't use real regex here since it causes deoptimization
      // and serious performance degradation in V8
      // https://github.com/zloirock/core-js/issues/306
      re = {};
      // RegExp[@@split] doesn't call the regex's exec method, but first creates
      // a new one. We need to return the patched regex when creating the new one.
      re.constructor = {};
      re.constructor[SPECIES$1] = function () { return re; };
      re.flags = '';
      re[SYMBOL] = /./[SYMBOL];
    }

    re.exec = function () { execCalled = true; return null; };

    re[SYMBOL]('');
    return !execCalled;
  });

  if (
    !DELEGATES_TO_SYMBOL ||
    !DELEGATES_TO_EXEC ||
    FORCED
  ) {
    var uncurriedNativeRegExpMethod = uncurryThis$8(/./[SYMBOL]);
    var methods = exec(SYMBOL, ''[KEY], function (nativeMethod, regexp, str, arg2, forceStringMethod) {
      var uncurriedNativeMethod = uncurryThis$8(nativeMethod);
      var $exec = regexp.exec;
      if ($exec === regexpExec$2 || $exec === RegExpPrototype$2.exec) {
        if (DELEGATES_TO_SYMBOL && !forceStringMethod) {
          // The native String method already delegates to @@method (this
          // polyfilled function), leasing to infinite recursion.
          // We avoid it by directly calling the native @@method method.
          return { done: true, value: uncurriedNativeRegExpMethod(regexp, str, arg2) };
        }
        return { done: true, value: uncurriedNativeMethod(str, regexp, arg2) };
      }
      return { done: false };
    });

    defineBuiltIn$3(String.prototype, KEY, methods[0]);
    defineBuiltIn$3(RegExpPrototype$2, SYMBOL, methods[1]);
  }

  if (SHAM) createNonEnumerableProperty$2(RegExpPrototype$2[SYMBOL], 'sham', true);
};

var isObject = isObject$6;
var classof$2 = classofRaw$1;
var wellKnownSymbol$6 = wellKnownSymbol$b;

var MATCH = wellKnownSymbol$6('match');

// `IsRegExp` abstract operation
// https://tc39.es/ecma262/#sec-isregexp
var isRegexp = function (it) {
  var isRegExp;
  return isObject(it) && ((isRegExp = it[MATCH]) !== undefined ? !!isRegExp : classof$2(it) == 'RegExp');
};

var uncurryThis$7 = functionUncurryThis;
var fails$6 = fails$j;
var isCallable$5 = isCallable$h;
var classof$1 = classof$4;
var getBuiltIn = getBuiltIn$5;
var inspectSource = inspectSource$3;

var noop = function () { /* empty */ };
var empty = [];
var construct = getBuiltIn('Reflect', 'construct');
var constructorRegExp = /^\s*(?:class|function)\b/;
var exec$2 = uncurryThis$7(constructorRegExp.exec);
var INCORRECT_TO_STRING = !constructorRegExp.exec(noop);

var isConstructorModern = function isConstructor(argument) {
  if (!isCallable$5(argument)) return false;
  try {
    construct(noop, empty, argument);
    return true;
  } catch (error) {
    return false;
  }
};

var isConstructorLegacy = function isConstructor(argument) {
  if (!isCallable$5(argument)) return false;
  switch (classof$1(argument)) {
    case 'AsyncFunction':
    case 'GeneratorFunction':
    case 'AsyncGeneratorFunction': return false;
  }
  try {
    // we can't check .prototype since constructors produced by .bind haven't it
    // `Function#toString` throws on some built-it function in some legacy engines
    // (for example, `DOMQuad` and similar in FF41-)
    return INCORRECT_TO_STRING || !!exec$2(constructorRegExp, inspectSource(argument));
  } catch (error) {
    return true;
  }
};

isConstructorLegacy.sham = true;

// `IsConstructor` abstract operation
// https://tc39.es/ecma262/#sec-isconstructor
var isConstructor$1 = !construct || fails$6(function () {
  var called;
  return isConstructorModern(isConstructorModern.call)
    || !isConstructorModern(Object)
    || !isConstructorModern(function () { called = true; })
    || called;
}) ? isConstructorLegacy : isConstructorModern;

var isConstructor = isConstructor$1;
var tryToString = tryToString$2;

var $TypeError$2 = TypeError;

// `Assert: IsConstructor(argument) is true`
var aConstructor$1 = function (argument) {
  if (isConstructor(argument)) return argument;
  throw $TypeError$2(tryToString(argument) + ' is not a constructor');
};

var anObject$4 = anObject$a;
var aConstructor = aConstructor$1;
var wellKnownSymbol$5 = wellKnownSymbol$b;

var SPECIES = wellKnownSymbol$5('species');

// `SpeciesConstructor` abstract operation
// https://tc39.es/ecma262/#sec-speciesconstructor
var speciesConstructor$1 = function (O, defaultConstructor) {
  var C = anObject$4(O).constructor;
  var S;
  return C === undefined || (S = anObject$4(C)[SPECIES]) == undefined ? defaultConstructor : aConstructor(S);
};

var uncurryThis$6 = functionUncurryThis;
var toIntegerOrInfinity$1 = toIntegerOrInfinity$4;
var toString$5 = toString$7;
var requireObjectCoercible$4 = requireObjectCoercible$7;

var charAt$1 = uncurryThis$6(''.charAt);
var charCodeAt = uncurryThis$6(''.charCodeAt);
var stringSlice$2 = uncurryThis$6(''.slice);

var createMethod$2 = function (CONVERT_TO_STRING) {
  return function ($this, pos) {
    var S = toString$5(requireObjectCoercible$4($this));
    var position = toIntegerOrInfinity$1(pos);
    var size = S.length;
    var first, second;
    if (position < 0 || position >= size) return CONVERT_TO_STRING ? '' : undefined;
    first = charCodeAt(S, position);
    return first < 0xD800 || first > 0xDBFF || position + 1 === size
      || (second = charCodeAt(S, position + 1)) < 0xDC00 || second > 0xDFFF
        ? CONVERT_TO_STRING
          ? charAt$1(S, position)
          : first
        : CONVERT_TO_STRING
          ? stringSlice$2(S, position, position + 2)
          : (first - 0xD800 << 10) + (second - 0xDC00) + 0x10000;
  };
};

var stringMultibyte = {
  // `String.prototype.codePointAt` method
  // https://tc39.es/ecma262/#sec-string.prototype.codepointat
  codeAt: createMethod$2(false),
  // `String.prototype.at` method
  // https://github.com/mathiasbynens/String.prototype.at
  charAt: createMethod$2(true)
};

var charAt = stringMultibyte.charAt;

// `AdvanceStringIndex` abstract operation
// https://tc39.es/ecma262/#sec-advancestringindex
var advanceStringIndex$1 = function (S, index, unicode) {
  return index + (unicode ? charAt(S, index).length : 1);
};

var toPropertyKey = toPropertyKey$3;
var definePropertyModule = objectDefineProperty;
var createPropertyDescriptor$1 = createPropertyDescriptor$4;

var createProperty$1 = function (object, key, value) {
  var propertyKey = toPropertyKey(key);
  if (propertyKey in object) definePropertyModule.f(object, propertyKey, createPropertyDescriptor$1(0, value));
  else object[propertyKey] = value;
};

var toAbsoluteIndex = toAbsoluteIndex$2;
var lengthOfArrayLike = lengthOfArrayLike$2;
var createProperty = createProperty$1;

var $Array = Array;
var max = Math.max;

var arraySliceSimple = function (O, start, end) {
  var length = lengthOfArrayLike(O);
  var k = toAbsoluteIndex(start, length);
  var fin = toAbsoluteIndex(end === undefined ? length : end, length);
  var result = $Array(max(fin - k, 0));
  for (var n = 0; k < fin; k++, n++) createProperty(result, n, O[k]);
  result.length = n;
  return result;
};

var call$4 = functionCall;
var anObject$3 = anObject$a;
var isCallable$4 = isCallable$h;
var classof = classofRaw$1;
var regexpExec$1 = regexpExec$3;

var $TypeError$1 = TypeError;

// `RegExpExec` abstract operation
// https://tc39.es/ecma262/#sec-regexpexec
var regexpExecAbstract = function (R, S) {
  var exec = R.exec;
  if (isCallable$4(exec)) {
    var result = call$4(exec, R, S);
    if (result !== null) anObject$3(result);
    return result;
  }
  if (classof(R) === 'RegExp') return call$4(regexpExec$1, R, S);
  throw $TypeError$1('RegExp#exec called on incompatible receiver');
};

var apply = functionApply;
var call$3 = functionCall;
var uncurryThis$5 = functionUncurryThis;
var fixRegExpWellKnownSymbolLogic = fixRegexpWellKnownSymbolLogic;
var isRegExp = isRegexp;
var anObject$2 = anObject$a;
var requireObjectCoercible$3 = requireObjectCoercible$7;
var speciesConstructor = speciesConstructor$1;
var advanceStringIndex = advanceStringIndex$1;
var toLength$1 = toLength$3;
var toString$4 = toString$7;
var getMethod = getMethod$2;
var arraySlice = arraySliceSimple;
var callRegExpExec = regexpExecAbstract;
var regexpExec = regexpExec$3;
var stickyHelpers = regexpStickyHelpers;
var fails$5 = fails$j;

var UNSUPPORTED_Y = stickyHelpers.UNSUPPORTED_Y;
var MAX_UINT32 = 0xFFFFFFFF;
var min = Math.min;
var $push = [].push;
var exec$1 = uncurryThis$5(/./.exec);
var push = uncurryThis$5($push);
var stringSlice$1 = uncurryThis$5(''.slice);

// Chrome 51 has a buggy "split" implementation when RegExp#exec !== nativeExec
// Weex JS has frozen built-in prototypes, so use try / catch wrapper
var SPLIT_WORKS_WITH_OVERWRITTEN_EXEC = !fails$5(function () {
  // eslint-disable-next-line regexp/no-empty-group -- required for testing
  var re = /(?:)/;
  var originalExec = re.exec;
  re.exec = function () { return originalExec.apply(this, arguments); };
  var result = 'ab'.split(re);
  return result.length !== 2 || result[0] !== 'a' || result[1] !== 'b';
});

// @@split logic
fixRegExpWellKnownSymbolLogic('split', function (SPLIT, nativeSplit, maybeCallNative) {
  var internalSplit;
  if (
    'abbc'.split(/(b)*/)[1] == 'c' ||
    // eslint-disable-next-line regexp/no-empty-group -- required for testing
    'test'.split(/(?:)/, -1).length != 4 ||
    'ab'.split(/(?:ab)*/).length != 2 ||
    '.'.split(/(.?)(.?)/).length != 4 ||
    // eslint-disable-next-line regexp/no-empty-capturing-group, regexp/no-empty-group -- required for testing
    '.'.split(/()()/).length > 1 ||
    ''.split(/.?/).length
  ) {
    // based on es5-shim implementation, need to rework it
    internalSplit = function (separator, limit) {
      var string = toString$4(requireObjectCoercible$3(this));
      var lim = limit === undefined ? MAX_UINT32 : limit >>> 0;
      if (lim === 0) return [];
      if (separator === undefined) return [string];
      // If `separator` is not a regex, use native split
      if (!isRegExp(separator)) {
        return call$3(nativeSplit, string, separator, lim);
      }
      var output = [];
      var flags = (separator.ignoreCase ? 'i' : '') +
                  (separator.multiline ? 'm' : '') +
                  (separator.unicode ? 'u' : '') +
                  (separator.sticky ? 'y' : '');
      var lastLastIndex = 0;
      // Make `global` and avoid `lastIndex` issues by working with a copy
      var separatorCopy = new RegExp(separator.source, flags + 'g');
      var match, lastIndex, lastLength;
      while (match = call$3(regexpExec, separatorCopy, string)) {
        lastIndex = separatorCopy.lastIndex;
        if (lastIndex > lastLastIndex) {
          push(output, stringSlice$1(string, lastLastIndex, match.index));
          if (match.length > 1 && match.index < string.length) apply($push, output, arraySlice(match, 1));
          lastLength = match[0].length;
          lastLastIndex = lastIndex;
          if (output.length >= lim) break;
        }
        if (separatorCopy.lastIndex === match.index) separatorCopy.lastIndex++; // Avoid an infinite loop
      }
      if (lastLastIndex === string.length) {
        if (lastLength || !exec$1(separatorCopy, '')) push(output, '');
      } else push(output, stringSlice$1(string, lastLastIndex));
      return output.length > lim ? arraySlice(output, 0, lim) : output;
    };
  // Chakra, V8
  } else if ('0'.split(undefined, 0).length) {
    internalSplit = function (separator, limit) {
      return separator === undefined && limit === 0 ? [] : call$3(nativeSplit, this, separator, limit);
    };
  } else internalSplit = nativeSplit;

  return [
    // `String.prototype.split` method
    // https://tc39.es/ecma262/#sec-string.prototype.split
    function split(separator, limit) {
      var O = requireObjectCoercible$3(this);
      var splitter = separator == undefined ? undefined : getMethod(separator, SPLIT);
      return splitter
        ? call$3(splitter, separator, O, limit)
        : call$3(internalSplit, toString$4(O), separator, limit);
    },
    // `RegExp.prototype[@@split]` method
    // https://tc39.es/ecma262/#sec-regexp.prototype-@@split
    //
    // NOTE: This cannot be properly polyfilled in engines that don't support
    // the 'y' flag.
    function (string, limit) {
      var rx = anObject$2(this);
      var S = toString$4(string);
      var res = maybeCallNative(internalSplit, rx, S, limit, internalSplit !== nativeSplit);

      if (res.done) return res.value;

      var C = speciesConstructor(rx, RegExp);

      var unicodeMatching = rx.unicode;
      var flags = (rx.ignoreCase ? 'i' : '') +
                  (rx.multiline ? 'm' : '') +
                  (rx.unicode ? 'u' : '') +
                  (UNSUPPORTED_Y ? 'g' : 'y');

      // ^(? + rx + ) is needed, in combination with some S slicing, to
      // simulate the 'y' flag.
      var splitter = new C(UNSUPPORTED_Y ? '^(?:' + rx.source + ')' : rx, flags);
      var lim = limit === undefined ? MAX_UINT32 : limit >>> 0;
      if (lim === 0) return [];
      if (S.length === 0) return callRegExpExec(splitter, S) === null ? [S] : [];
      var p = 0;
      var q = 0;
      var A = [];
      while (q < S.length) {
        splitter.lastIndex = UNSUPPORTED_Y ? 0 : q;
        var z = callRegExpExec(splitter, UNSUPPORTED_Y ? stringSlice$1(S, q) : S);
        var e;
        if (
          z === null ||
          (e = min(toLength$1(splitter.lastIndex + (UNSUPPORTED_Y ? q : 0)), S.length)) === p
        ) {
          q = advanceStringIndex(S, q, unicodeMatching);
        } else {
          push(A, stringSlice$1(S, p, q));
          if (A.length === lim) return A;
          for (var i = 1; i <= z.length - 1; i++) {
            push(A, z[i]);
            if (A.length === lim) return A;
          }
          q = p = e;
        }
      }
      push(A, stringSlice$1(S, p));
      return A;
    }
  ];
}, !SPLIT_WORKS_WITH_OVERWRITTEN_EXEC, UNSUPPORTED_Y);

// a string of all valid unicode whitespaces
var whitespaces$2 = '\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002' +
  '\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\u2028\u2029\uFEFF';

var uncurryThis$4 = functionUncurryThis;
var requireObjectCoercible$2 = requireObjectCoercible$7;
var toString$3 = toString$7;
var whitespaces$1 = whitespaces$2;

var replace = uncurryThis$4(''.replace);
var whitespace = '[' + whitespaces$1 + ']';
var ltrim = RegExp('^' + whitespace + whitespace + '*');
var rtrim = RegExp(whitespace + whitespace + '*$');

// `String.prototype.{ trim, trimStart, trimEnd, trimLeft, trimRight }` methods implementation
var createMethod$1 = function (TYPE) {
  return function ($this) {
    var string = toString$3(requireObjectCoercible$2($this));
    if (TYPE & 1) string = replace(string, ltrim, '');
    if (TYPE & 2) string = replace(string, rtrim, '');
    return string;
  };
};

var stringTrim = {
  // `String.prototype.{ trimLeft, trimStart }` methods
  // https://tc39.es/ecma262/#sec-string.prototype.trimstart
  start: createMethod$1(1),
  // `String.prototype.{ trimRight, trimEnd }` methods
  // https://tc39.es/ecma262/#sec-string.prototype.trimend
  end: createMethod$1(2),
  // `String.prototype.trim` method
  // https://tc39.es/ecma262/#sec-string.prototype.trim
  trim: createMethod$1(3)
};

var global$2 = global$f;
var fails$4 = fails$j;
var uncurryThis$3 = functionUncurryThis;
var toString$2 = toString$7;
var trim = stringTrim.trim;
var whitespaces = whitespaces$2;

var $parseInt$1 = global$2.parseInt;
var Symbol$1 = global$2.Symbol;
var ITERATOR$3 = Symbol$1 && Symbol$1.iterator;
var hex = /^[+-]?0x/i;
var exec = uncurryThis$3(hex.exec);
var FORCED = $parseInt$1(whitespaces + '08') !== 8 || $parseInt$1(whitespaces + '0x16') !== 22
  // MS Edge 18- broken with boxed symbols
  || (ITERATOR$3 && !fails$4(function () { $parseInt$1(Object(ITERATOR$3)); }));

// `parseInt` method
// https://tc39.es/ecma262/#sec-parseint-string-radix
var numberParseInt = FORCED ? function parseInt(string, radix) {
  var S = trim(toString$2(string));
  return $parseInt$1(S, (radix >>> 0) || (exec(hex, S) ? 16 : 10));
} : $parseInt$1;

var $$3 = _export;
var $parseInt = numberParseInt;

// `parseInt` method
// https://tc39.es/ecma262/#sec-parseint-string-radix
$$3({ global: true, forced: parseInt != $parseInt }, {
  parseInt: $parseInt
});

var call$2 = functionCall;
var hasOwn$2 = hasOwnProperty_1;
var isPrototypeOf = objectIsPrototypeOf;
var regExpFlags = regexpFlags$1;

var RegExpPrototype$1 = RegExp.prototype;

var regexpGetFlags = function (R) {
  var flags = R.flags;
  return flags === undefined && !('flags' in RegExpPrototype$1) && !hasOwn$2(R, 'flags') && isPrototypeOf(RegExpPrototype$1, R)
    ? call$2(regExpFlags, R) : flags;
};

var PROPER_FUNCTION_NAME$1 = functionName.PROPER;
var defineBuiltIn$2 = defineBuiltIn$5;
var anObject$1 = anObject$a;
var $toString = toString$7;
var fails$3 = fails$j;
var getRegExpFlags = regexpGetFlags;

var TO_STRING = 'toString';
var RegExpPrototype = RegExp.prototype;
var n$ToString = RegExpPrototype[TO_STRING];

var NOT_GENERIC = fails$3(function () { return n$ToString.call({ source: 'a', flags: 'b' }) != '/a/b'; });
// FF44- RegExp#toString has a wrong name
var INCORRECT_NAME = PROPER_FUNCTION_NAME$1 && n$ToString.name != TO_STRING;

// `RegExp.prototype.toString` method
// https://tc39.es/ecma262/#sec-regexp.prototype.tostring
if (NOT_GENERIC || INCORRECT_NAME) {
  defineBuiltIn$2(RegExp.prototype, TO_STRING, function toString() {
    var R = anObject$1(this);
    var pattern = $toString(R.source);
    var flags = $toString(getRegExpFlags(R));
    return '/' + pattern + '/' + flags;
  }, { unsafe: true });
}

const FEATURE_ROW_INDEX = 0;
const FEATURE_COL_INDEX = 1;
const FEATURE_CELLS_START_INDEX = 2;
const CELL_NUM_INDEX = 0;
const CELL_START_INDEX = 1;
const CELL_END_INDEX = 2;
const CELL_VALUES_START_INDEX = 3; // Values from the 4wings API in intArray form can't be floats, so they are multiplied by a factor, here we get back to the original value

const VALUE_MULTIPLIER = 100;

const getCellValues = rawValues => {
  // Raw values come as a single string (MVT limitation), turn into an array of ints first
  const values = Array.isArray(rawValues) ? rawValues : rawValues.slice(1, -1).split(',').map(v => parseInt(v)); // First two values for a cell are the overall start and end time offsets for all the cell values (in days/hours/10days from start of time)

  const minCellOffset = values[CELL_START_INDEX];
  const maxCellOffset = values[CELL_END_INDEX];
  return {
    values,
    minCellOffset,
    maxCellOffset
  };
};
const getRealValue = (rawValue, {
  multiplier: _multiplier = VALUE_MULTIPLIER,
  offset: _offset = 0
} = {}) => {
  return rawValue / _multiplier - _offset;
};
const getRealValues = (rawValues, options = {}) => {
  // Raw 4w API values come without decimals, multiplied by 100
  const realValues = rawValues.map(sublayerValue => getRealValue(sublayerValue, options));
  return realValues;
};
const getCellArrayIndex = (minCellOffset, numSublayers, offset) => {
  return CELL_VALUES_START_INDEX + (offset - minCellOffset) * numSublayers;
};

const getLastDigit = num => parseInt(num.toString().slice(-1)); // In order for setFeatureState to work correctly, generate unique IDs across viewport-visible tiles:
// concatenate last x/z digits and cell increment index (goal is to get numbers as small as possible)


const generateUniqueId = (x, y, cellId) => parseInt([getLastDigit(x) + 1, getLastDigit(y) + 1, cellId].join(''));

var GeomType;

(function (GeomType) {
  GeomType["point"] = "point";
  GeomType["rectangle"] = "rectangle";
})(GeomType || (GeomType = {}));

var SublayerCombinationMode;

(function (SublayerCombinationMode) {
  SublayerCombinationMode["None"] = "none"; // Add all sublayer raw values

  SublayerCombinationMode["Add"] = "add"; // Returns a bucket index depending on sublayer with highest value + position on sublayer color ramp

  SublayerCombinationMode["Max"] = "max"; // Returns a bucket index depending on delta value between two sublayers

  SublayerCombinationMode["TimeCompare"] = "timecompare"; // Returns a bucket index depending on a 2D color ramp

  SublayerCombinationMode["Bivariate"] = "bivariate"; // Returns raw values that can be decoded with JSON.parse (number or array of numbers). Used for interaction layer

  SublayerCombinationMode["Literal"] = "literal"; // Returns raw values as a string in the format AAAABBBBCCCC (where A, B, C, 3 sublayers), and where BBBB is
  // sublayer 0 + sublayer 1 and CCCC is sublayer 0 + sublayer 1 + sublayer 2. Used for extruded layer.

  SublayerCombinationMode["Cumulative"] = "cumulative";
})(SublayerCombinationMode || (SublayerCombinationMode = {}));

var AggregationOperation;

(function (AggregationOperation) {
  AggregationOperation["Sum"] = "sum";
  AggregationOperation["Avg"] = "avg";
})(AggregationOperation || (AggregationOperation = {}));

var wellKnownSymbol$4 = wellKnownSymbol$b;
var create$1 = objectCreate;
var defineProperty$3 = objectDefineProperty.f;

var UNSCOPABLES = wellKnownSymbol$4('unscopables');
var ArrayPrototype = Array.prototype;

// Array.prototype[@@unscopables]
// https://tc39.es/ecma262/#sec-array.prototype-@@unscopables
if (ArrayPrototype[UNSCOPABLES] == undefined) {
  defineProperty$3(ArrayPrototype, UNSCOPABLES, {
    configurable: true,
    value: create$1(null)
  });
}

// add a key to Array.prototype[@@unscopables]
var addToUnscopables$1 = function (key) {
  ArrayPrototype[UNSCOPABLES][key] = true;
};

var iterators = {};

var fails$2 = fails$j;

var correctPrototypeGetter = !fails$2(function () {
  function F() { /* empty */ }
  F.prototype.constructor = null;
  // eslint-disable-next-line es-x/no-object-getprototypeof -- required for testing
  return Object.getPrototypeOf(new F()) !== F.prototype;
});

var hasOwn$1 = hasOwnProperty_1;
var isCallable$3 = isCallable$h;
var toObject$1 = toObject$3;
var sharedKey = sharedKey$3;
var CORRECT_PROTOTYPE_GETTER = correctPrototypeGetter;

var IE_PROTO = sharedKey('IE_PROTO');
var $Object = Object;
var ObjectPrototype = $Object.prototype;

// `Object.getPrototypeOf` method
// https://tc39.es/ecma262/#sec-object.getprototypeof
// eslint-disable-next-line es-x/no-object-getprototypeof -- safe
var objectGetPrototypeOf = CORRECT_PROTOTYPE_GETTER ? $Object.getPrototypeOf : function (O) {
  var object = toObject$1(O);
  if (hasOwn$1(object, IE_PROTO)) return object[IE_PROTO];
  var constructor = object.constructor;
  if (isCallable$3(constructor) && object instanceof constructor) {
    return constructor.prototype;
  } return object instanceof $Object ? ObjectPrototype : null;
};

var fails$1 = fails$j;
var isCallable$2 = isCallable$h;
var getPrototypeOf$1 = objectGetPrototypeOf;
var defineBuiltIn$1 = defineBuiltIn$5;
var wellKnownSymbol$3 = wellKnownSymbol$b;

var ITERATOR$2 = wellKnownSymbol$3('iterator');
var BUGGY_SAFARI_ITERATORS$1 = false;

// `%IteratorPrototype%` object
// https://tc39.es/ecma262/#sec-%iteratorprototype%-object
var IteratorPrototype$2, PrototypeOfArrayIteratorPrototype, arrayIterator;

/* eslint-disable es-x/no-array-prototype-keys -- safe */
if ([].keys) {
  arrayIterator = [].keys();
  // Safari 8 has buggy iterators w/o `next`
  if (!('next' in arrayIterator)) BUGGY_SAFARI_ITERATORS$1 = true;
  else {
    PrototypeOfArrayIteratorPrototype = getPrototypeOf$1(getPrototypeOf$1(arrayIterator));
    if (PrototypeOfArrayIteratorPrototype !== Object.prototype) IteratorPrototype$2 = PrototypeOfArrayIteratorPrototype;
  }
}

var NEW_ITERATOR_PROTOTYPE = IteratorPrototype$2 == undefined || fails$1(function () {
  var test = {};
  // FF44- legacy iterators case
  return IteratorPrototype$2[ITERATOR$2].call(test) !== test;
});

if (NEW_ITERATOR_PROTOTYPE) IteratorPrototype$2 = {};

// `%IteratorPrototype%[@@iterator]()` method
// https://tc39.es/ecma262/#sec-%iteratorprototype%-@@iterator
if (!isCallable$2(IteratorPrototype$2[ITERATOR$2])) {
  defineBuiltIn$1(IteratorPrototype$2, ITERATOR$2, function () {
    return this;
  });
}

var iteratorsCore = {
  IteratorPrototype: IteratorPrototype$2,
  BUGGY_SAFARI_ITERATORS: BUGGY_SAFARI_ITERATORS$1
};

var defineProperty$2 = objectDefineProperty.f;
var hasOwn = hasOwnProperty_1;
var wellKnownSymbol$2 = wellKnownSymbol$b;

var TO_STRING_TAG$1 = wellKnownSymbol$2('toStringTag');

var setToStringTag$2 = function (target, TAG, STATIC) {
  if (target && !STATIC) target = target.prototype;
  if (target && !hasOwn(target, TO_STRING_TAG$1)) {
    defineProperty$2(target, TO_STRING_TAG$1, { configurable: true, value: TAG });
  }
};

var IteratorPrototype$1 = iteratorsCore.IteratorPrototype;
var create = objectCreate;
var createPropertyDescriptor = createPropertyDescriptor$4;
var setToStringTag$1 = setToStringTag$2;
var Iterators$2 = iterators;

var returnThis$1 = function () { return this; };

var createIteratorConstructor$1 = function (IteratorConstructor, NAME, next, ENUMERABLE_NEXT) {
  var TO_STRING_TAG = NAME + ' Iterator';
  IteratorConstructor.prototype = create(IteratorPrototype$1, { next: createPropertyDescriptor(+!ENUMERABLE_NEXT, next) });
  setToStringTag$1(IteratorConstructor, TO_STRING_TAG, false);
  Iterators$2[TO_STRING_TAG] = returnThis$1;
  return IteratorConstructor;
};

var isCallable$1 = isCallable$h;

var $String = String;
var $TypeError = TypeError;

var aPossiblePrototype$1 = function (argument) {
  if (typeof argument == 'object' || isCallable$1(argument)) return argument;
  throw $TypeError("Can't set " + $String(argument) + ' as a prototype');
};

/* eslint-disable no-proto -- safe */

var uncurryThis$2 = functionUncurryThis;
var anObject = anObject$a;
var aPossiblePrototype = aPossiblePrototype$1;

// `Object.setPrototypeOf` method
// https://tc39.es/ecma262/#sec-object.setprototypeof
// Works with __proto__ only. Old v8 can't work with null proto objects.
// eslint-disable-next-line es-x/no-object-setprototypeof -- safe
var objectSetPrototypeOf = Object.setPrototypeOf || ('__proto__' in {} ? function () {
  var CORRECT_SETTER = false;
  var test = {};
  var setter;
  try {
    // eslint-disable-next-line es-x/no-object-getownpropertydescriptor -- safe
    setter = uncurryThis$2(Object.getOwnPropertyDescriptor(Object.prototype, '__proto__').set);
    setter(test, []);
    CORRECT_SETTER = test instanceof Array;
  } catch (error) { /* empty */ }
  return function setPrototypeOf(O, proto) {
    anObject(O);
    aPossiblePrototype(proto);
    if (CORRECT_SETTER) setter(O, proto);
    else O.__proto__ = proto;
    return O;
  };
}() : undefined);

var $$2 = _export;
var call$1 = functionCall;
var FunctionName = functionName;
var isCallable = isCallable$h;
var createIteratorConstructor = createIteratorConstructor$1;
var getPrototypeOf = objectGetPrototypeOf;
var setPrototypeOf = objectSetPrototypeOf;
var setToStringTag = setToStringTag$2;
var createNonEnumerableProperty$1 = createNonEnumerableProperty$5;
var defineBuiltIn = defineBuiltIn$5;
var wellKnownSymbol$1 = wellKnownSymbol$b;
var Iterators$1 = iterators;
var IteratorsCore = iteratorsCore;

var PROPER_FUNCTION_NAME = FunctionName.PROPER;
var CONFIGURABLE_FUNCTION_NAME = FunctionName.CONFIGURABLE;
var IteratorPrototype = IteratorsCore.IteratorPrototype;
var BUGGY_SAFARI_ITERATORS = IteratorsCore.BUGGY_SAFARI_ITERATORS;
var ITERATOR$1 = wellKnownSymbol$1('iterator');
var KEYS = 'keys';
var VALUES = 'values';
var ENTRIES = 'entries';

var returnThis = function () { return this; };

var defineIterator$1 = function (Iterable, NAME, IteratorConstructor, next, DEFAULT, IS_SET, FORCED) {
  createIteratorConstructor(IteratorConstructor, NAME, next);

  var getIterationMethod = function (KIND) {
    if (KIND === DEFAULT && defaultIterator) return defaultIterator;
    if (!BUGGY_SAFARI_ITERATORS && KIND in IterablePrototype) return IterablePrototype[KIND];
    switch (KIND) {
      case KEYS: return function keys() { return new IteratorConstructor(this, KIND); };
      case VALUES: return function values() { return new IteratorConstructor(this, KIND); };
      case ENTRIES: return function entries() { return new IteratorConstructor(this, KIND); };
    } return function () { return new IteratorConstructor(this); };
  };

  var TO_STRING_TAG = NAME + ' Iterator';
  var INCORRECT_VALUES_NAME = false;
  var IterablePrototype = Iterable.prototype;
  var nativeIterator = IterablePrototype[ITERATOR$1]
    || IterablePrototype['@@iterator']
    || DEFAULT && IterablePrototype[DEFAULT];
  var defaultIterator = !BUGGY_SAFARI_ITERATORS && nativeIterator || getIterationMethod(DEFAULT);
  var anyNativeIterator = NAME == 'Array' ? IterablePrototype.entries || nativeIterator : nativeIterator;
  var CurrentIteratorPrototype, methods, KEY;

  // fix native
  if (anyNativeIterator) {
    CurrentIteratorPrototype = getPrototypeOf(anyNativeIterator.call(new Iterable()));
    if (CurrentIteratorPrototype !== Object.prototype && CurrentIteratorPrototype.next) {
      if (getPrototypeOf(CurrentIteratorPrototype) !== IteratorPrototype) {
        if (setPrototypeOf) {
          setPrototypeOf(CurrentIteratorPrototype, IteratorPrototype);
        } else if (!isCallable(CurrentIteratorPrototype[ITERATOR$1])) {
          defineBuiltIn(CurrentIteratorPrototype, ITERATOR$1, returnThis);
        }
      }
      // Set @@toStringTag to native iterators
      setToStringTag(CurrentIteratorPrototype, TO_STRING_TAG, true);
    }
  }

  // fix Array.prototype.{ values, @@iterator }.name in V8 / FF
  if (PROPER_FUNCTION_NAME && DEFAULT == VALUES && nativeIterator && nativeIterator.name !== VALUES) {
    if (CONFIGURABLE_FUNCTION_NAME) {
      createNonEnumerableProperty$1(IterablePrototype, 'name', VALUES);
    } else {
      INCORRECT_VALUES_NAME = true;
      defaultIterator = function values() { return call$1(nativeIterator, this); };
    }
  }

  // export additional methods
  if (DEFAULT) {
    methods = {
      values: getIterationMethod(VALUES),
      keys: IS_SET ? defaultIterator : getIterationMethod(KEYS),
      entries: getIterationMethod(ENTRIES)
    };
    if (FORCED) for (KEY in methods) {
      if (BUGGY_SAFARI_ITERATORS || INCORRECT_VALUES_NAME || !(KEY in IterablePrototype)) {
        defineBuiltIn(IterablePrototype, KEY, methods[KEY]);
      }
    } else $$2({ target: NAME, proto: true, forced: BUGGY_SAFARI_ITERATORS || INCORRECT_VALUES_NAME }, methods);
  }

  // define iterator
  if (IterablePrototype[ITERATOR$1] !== defaultIterator) {
    defineBuiltIn(IterablePrototype, ITERATOR$1, defaultIterator, { name: DEFAULT });
  }
  Iterators$1[NAME] = defaultIterator;

  return methods;
};

var toIndexedObject = toIndexedObject$5;
var addToUnscopables = addToUnscopables$1;
var Iterators = iterators;
var InternalStateModule = internalState;
var defineProperty$1 = objectDefineProperty.f;
var defineIterator = defineIterator$1;
var DESCRIPTORS$1 = descriptors;

var ARRAY_ITERATOR = 'Array Iterator';
var setInternalState = InternalStateModule.set;
var getInternalState = InternalStateModule.getterFor(ARRAY_ITERATOR);

// `Array.prototype.entries` method
// https://tc39.es/ecma262/#sec-array.prototype.entries
// `Array.prototype.keys` method
// https://tc39.es/ecma262/#sec-array.prototype.keys
// `Array.prototype.values` method
// https://tc39.es/ecma262/#sec-array.prototype.values
// `Array.prototype[@@iterator]` method
// https://tc39.es/ecma262/#sec-array.prototype-@@iterator
// `CreateArrayIterator` internal method
// https://tc39.es/ecma262/#sec-createarrayiterator
var es_array_iterator = defineIterator(Array, 'Array', function (iterated, kind) {
  setInternalState(this, {
    type: ARRAY_ITERATOR,
    target: toIndexedObject(iterated), // target
    index: 0,                          // next index
    kind: kind                         // kind
  });
// `%ArrayIteratorPrototype%.next` method
// https://tc39.es/ecma262/#sec-%arrayiteratorprototype%.next
}, function () {
  var state = getInternalState(this);
  var target = state.target;
  var kind = state.kind;
  var index = state.index++;
  if (!target || index >= target.length) {
    state.target = undefined;
    return { value: undefined, done: true };
  }
  if (kind == 'keys') return { value: index, done: false };
  if (kind == 'values') return { value: target[index], done: false };
  return { value: [index, target[index]], done: false };
}, 'values');

// argumentsList[@@iterator] is %ArrayProto_values%
// https://tc39.es/ecma262/#sec-createunmappedargumentsobject
// https://tc39.es/ecma262/#sec-createmappedargumentsobject
var values = Iterators.Arguments = Iterators.Array;

// https://tc39.es/ecma262/#sec-array.prototype-@@unscopables
addToUnscopables('keys');
addToUnscopables('values');
addToUnscopables('entries');

// V8 ~ Chrome 45- bug
if (DESCRIPTORS$1 && values.name !== 'values') try {
  defineProperty$1(values, 'name', { value: 'values' });
} catch (error) { /* empty */ }

// iterable DOM collections
// flag - `iterable` interface - 'entries', 'keys', 'values', 'forEach' methods
var domIterables = {
  CSSRuleList: 0,
  CSSStyleDeclaration: 0,
  CSSValueList: 0,
  ClientRectList: 0,
  DOMRectList: 0,
  DOMStringList: 0,
  DOMTokenList: 1,
  DataTransferItemList: 0,
  FileList: 0,
  HTMLAllCollection: 0,
  HTMLCollection: 0,
  HTMLFormElement: 0,
  HTMLSelectElement: 0,
  MediaList: 0,
  MimeTypeArray: 0,
  NamedNodeMap: 0,
  NodeList: 1,
  PaintRequestList: 0,
  Plugin: 0,
  PluginArray: 0,
  SVGLengthList: 0,
  SVGNumberList: 0,
  SVGPathSegList: 0,
  SVGPointList: 0,
  SVGStringList: 0,
  SVGTransformList: 0,
  SourceBufferList: 0,
  StyleSheetList: 0,
  TextTrackCueList: 0,
  TextTrackList: 0,
  TouchList: 0
};

// in old WebKit versions, `element.classList` is not an instance of global `DOMTokenList`
var documentCreateElement = documentCreateElement$2;

var classList = documentCreateElement('span').classList;
var DOMTokenListPrototype$1 = classList && classList.constructor && classList.constructor.prototype;

var domTokenListPrototype = DOMTokenListPrototype$1 === Object.prototype ? undefined : DOMTokenListPrototype$1;

var global$1 = global$f;
var DOMIterables = domIterables;
var DOMTokenListPrototype = domTokenListPrototype;
var ArrayIteratorMethods = es_array_iterator;
var createNonEnumerableProperty = createNonEnumerableProperty$5;
var wellKnownSymbol = wellKnownSymbol$b;

var ITERATOR = wellKnownSymbol('iterator');
var TO_STRING_TAG = wellKnownSymbol('toStringTag');
var ArrayValues = ArrayIteratorMethods.values;

var handlePrototype = function (CollectionPrototype, COLLECTION_NAME) {
  if (CollectionPrototype) {
    // some Chrome versions have non-configurable methods on DOMTokenList
    if (CollectionPrototype[ITERATOR] !== ArrayValues) try {
      createNonEnumerableProperty(CollectionPrototype, ITERATOR, ArrayValues);
    } catch (error) {
      CollectionPrototype[ITERATOR] = ArrayValues;
    }
    if (!CollectionPrototype[TO_STRING_TAG]) {
      createNonEnumerableProperty(CollectionPrototype, TO_STRING_TAG, COLLECTION_NAME);
    }
    if (DOMIterables[COLLECTION_NAME]) for (var METHOD_NAME in ArrayIteratorMethods) {
      // some Chrome versions have non-configurable methods on DOMTokenList
      if (CollectionPrototype[METHOD_NAME] !== ArrayIteratorMethods[METHOD_NAME]) try {
        createNonEnumerableProperty(CollectionPrototype, METHOD_NAME, ArrayIteratorMethods[METHOD_NAME]);
      } catch (error) {
        CollectionPrototype[METHOD_NAME] = ArrayIteratorMethods[METHOD_NAME];
      }
    }
  }
};

for (var COLLECTION_NAME in DOMIterables) {
  handlePrototype(global$1[COLLECTION_NAME] && global$1[COLLECTION_NAME].prototype, COLLECTION_NAME);
}

handlePrototype(DOMTokenListPrototype, 'DOMTokenList');

const aggregateCell = ({
  rawValues,
  frame,
  delta,
  quantizeOffset,
  sublayerCount,
  aggregationOperation: _aggregationOperation = AggregationOperation.Sum,
  sublayerCombinationMode: _sublayerCombinationMode = SublayerCombinationMode.Max,
  multiplier: _multiplier = VALUE_MULTIPLIER
}) => {
  if (!rawValues) return null;
  const {
    values,
    minCellOffset,
    maxCellOffset
  } = getCellValues(rawValues); // When we should start counting in terms of days/hours/10days from start of time

  const startOffset = quantizeOffset + frame;
  const endOffset = startOffset + delta;

  if (startOffset > maxCellOffset || endOffset < minCellOffset) {
    return null;
  }

  const cellStartOffset = Math.max(startOffset, minCellOffset);
  const cellEndOffset = Math.min(endOffset, maxCellOffset); // Where we sould start looking up in the array (minCellOffset, maxCellOffset, sublayer0valueAt0, sublayer1valueAt0, sublayer0valueAt1, sublayer1valueAt1, ...)

  const startAt = getCellArrayIndex(minCellOffset, sublayerCount, cellStartOffset);
  const endAt = getCellArrayIndex(minCellOffset, sublayerCount, cellEndOffset);
  const rawValuesArrSlice = values.slice(startAt, endAt); // One aggregated value per sublayer

  let aggregatedValues = new Array(sublayerCount).fill(0);
  let numValues = 0;

  for (let i = 0; i < rawValuesArrSlice.length; i++) {
    const sublayerIndex = i % sublayerCount;
    const rawValue = rawValuesArrSlice[i];

    if (rawValue !== null && rawValue !== undefined && !isNaN(rawValue) && rawValue !== 0) {
      aggregatedValues[sublayerIndex] += rawValue;
      if (sublayerIndex === 0) numValues++;
    }
  }

  if (_aggregationOperation === AggregationOperation.Avg && numValues > 0) {
    aggregatedValues = aggregatedValues.map(sublayerValue => sublayerValue / numValues);
  }

  const realValues = getRealValues(aggregatedValues, {
    multiplier: _multiplier
  });

  if (_sublayerCombinationMode === SublayerCombinationMode.TimeCompare) {
    return [realValues[1] - realValues[0]];
  }

  return realValues;
};

var DESCRIPTORS = descriptors;
var uncurryThis$1 = functionUncurryThis;
var call = functionCall;
var fails = fails$j;
var objectKeys = objectKeys$2;
var getOwnPropertySymbolsModule = objectGetOwnPropertySymbols;
var propertyIsEnumerableModule = objectPropertyIsEnumerable;
var toObject = toObject$3;
var IndexedObject = indexedObject;

// eslint-disable-next-line es-x/no-object-assign -- safe
var $assign = Object.assign;
// eslint-disable-next-line es-x/no-object-defineproperty -- required for testing
var defineProperty = Object.defineProperty;
var concat = uncurryThis$1([].concat);

// `Object.assign` method
// https://tc39.es/ecma262/#sec-object.assign
var objectAssign = !$assign || fails(function () {
  // should have correct order of operations (Edge bug)
  if (DESCRIPTORS && $assign({ b: 1 }, $assign(defineProperty({}, 'a', {
    enumerable: true,
    get: function () {
      defineProperty(this, 'b', {
        value: 3,
        enumerable: false
      });
    }
  }), { b: 2 })).b !== 1) return true;
  // should work with symbols and should have deterministic property order (V8 bug)
  var A = {};
  var B = {};
  // eslint-disable-next-line es-x/no-symbol -- safe
  var symbol = Symbol();
  var alphabet = 'abcdefghijklmnopqrst';
  A[symbol] = 7;
  alphabet.split('').forEach(function (chr) { B[chr] = chr; });
  return $assign({}, A)[symbol] != 7 || objectKeys($assign({}, B)).join('') != alphabet;
}) ? function assign(target, source) { // eslint-disable-line no-unused-vars -- required for `.length`
  var T = toObject(target);
  var argumentsLength = arguments.length;
  var index = 1;
  var getOwnPropertySymbols = getOwnPropertySymbolsModule.f;
  var propertyIsEnumerable = propertyIsEnumerableModule.f;
  while (argumentsLength > index) {
    var S = IndexedObject(arguments[index++]);
    var keys = getOwnPropertySymbols ? concat(objectKeys(S), getOwnPropertySymbols(S)) : objectKeys(S);
    var length = keys.length;
    var j = 0;
    var key;
    while (length > j) {
      key = keys[j++];
      if (!DESCRIPTORS || call(propertyIsEnumerable, S, key)) T[key] = S[key];
    }
  } return T;
} : $assign;

var $$1 = _export;
var assign = objectAssign;

// `Object.assign` method
// https://tc39.es/ecma262/#sec-object.assign
// eslint-disable-next-line es-x/no-object-assign -- required for testing
$$1({ target: 'Object', stat: true, arity: 2, forced: Object.assign !== assign }, {
  assign: assign
});

var toIntegerOrInfinity = toIntegerOrInfinity$4;
var toString$1 = toString$7;
var requireObjectCoercible$1 = requireObjectCoercible$7;

var $RangeError = RangeError;

// `String.prototype.repeat` method implementation
// https://tc39.es/ecma262/#sec-string.prototype.repeat
var stringRepeat = function repeat(count) {
  var str = toString$1(requireObjectCoercible$1(this));
  var result = '';
  var n = toIntegerOrInfinity(count);
  if (n < 0 || n == Infinity) throw $RangeError('Wrong number of repetitions');
  for (;n > 0; (n >>>= 1) && (str += str)) if (n & 1) result += str;
  return result;
};

// https://github.com/tc39/proposal-string-pad-start-end
var uncurryThis = functionUncurryThis;
var toLength = toLength$3;
var toString = toString$7;
var $repeat = stringRepeat;
var requireObjectCoercible = requireObjectCoercible$7;

var repeat = uncurryThis($repeat);
var stringSlice = uncurryThis(''.slice);
var ceil = Math.ceil;

// `String.prototype.{ padStart, padEnd }` methods implementation
var createMethod = function (IS_END) {
  return function ($this, maxLength, fillString) {
    var S = toString(requireObjectCoercible($this));
    var intMaxLength = toLength(maxLength);
    var stringLength = S.length;
    var fillStr = fillString === undefined ? ' ' : toString(fillString);
    var fillLen, stringFiller;
    if (intMaxLength <= stringLength || fillStr == '') return S;
    fillLen = intMaxLength - stringLength;
    stringFiller = repeat(fillStr, ceil(fillLen / fillStr.length));
    if (stringFiller.length > fillLen) stringFiller = stringSlice(stringFiller, 0, fillLen);
    return IS_END ? S + stringFiller : stringFiller + S;
  };
};

var stringPad = {
  // `String.prototype.padStart` method
  // https://tc39.es/ecma262/#sec-string.prototype.padstart
  start: createMethod(false),
  // `String.prototype.padEnd` method
  // https://tc39.es/ecma262/#sec-string.prototype.padend
  end: createMethod(true)
};

// https://github.com/zloirock/core-js/issues/280
var userAgent = engineUserAgent;

var stringPadWebkitBug = /Version\/10(?:\.\d+){1,2}(?: [\w./]+)?(?: Mobile\/\w+)? Safari\//.test(userAgent);

var $ = _export;
var $padStart = stringPad.start;
var WEBKIT_BUG = stringPadWebkitBug;

// `String.prototype.padStart` method
// https://tc39.es/ecma262/#sec-string.prototype.padstart
$({ target: 'String', proto: true, forced: WEBKIT_BUG }, {
  padStart: function padStart(maxLength /* , fillString = ' ' */) {
    return $padStart(this, maxLength, arguments.length > 1 ? arguments[1] : undefined);
  }
});

const getCellCoords = (tileBBox, cell, numCols) => {
  const col = cell % numCols;
  const row = Math.floor(cell / numCols);
  const [minX, minY, maxX, maxY] = tileBBox;
  const width = maxX - minX;
  const height = maxY - minY;
  return {
    col,
    row,
    width,
    height
  };
};

const getPointFeature = ({
  tileBBox,
  cell,
  numCols,
  numRows,
  addMeta
}) => {
  const [minX, minY] = tileBBox;
  const {
    col,
    row,
    width,
    height
  } = getCellCoords(tileBBox, cell, numCols);
  const pointMinX = minX + col / numCols * width;
  const pointMinY = minY + row / numRows * height;
  const properties = addMeta ? {
    _col: col,
    _row: row
  } : {};
  return {
    type: 'Feature',
    properties,
    geometry: {
      type: 'Point',
      coordinates: [pointMinX, pointMinY]
    }
  };
};

const getRectangleFeature = ({
  tileBBox,
  cell,
  numCols,
  numRows,
  addMeta
}) => {
  const [minX, minY] = tileBBox;
  const {
    col,
    row,
    width,
    height
  } = getCellCoords(tileBBox, cell, numCols);
  const squareMinX = minX + col / numCols * width;
  const squareMinY = minY + row / numRows * height;
  const squareMaxX = minX + (col + 1) / numCols * width;
  const squareMaxY = minY + (row + 1) / numRows * height;
  const properties = addMeta ? {
    _col: col,
    _row: row
  } : {};
  return {
    type: 'Feature',
    properties,
    geometry: {
      type: 'Polygon',
      coordinates: [[[squareMinX, squareMinY], [squareMaxX, squareMinY], [squareMaxX, squareMaxY], [squareMinX, squareMaxY], [squareMinX, squareMinY]]]
    }
  };
};

const getFeature = featureParams => {
  const feature = featureParams.geomType === GeomType.point ? getPointFeature(featureParams) : getRectangleFeature(featureParams);
  feature.id = featureParams.id;
  return feature;
};

const writeValueToFeature = (quantizedTail, valueToWrite, feature) => {
  const propertiesKey = quantizedTail.toString();

  if (valueToWrite !== undefined) {
    // Saving NaN in feature property value complicates the expressions a lot, saving null instead
    feature.properties[propertiesKey] = isNaN(valueToWrite) ? null : valueToWrite;
  }
}; // Given breaks [[0, 10, 20, 30], [-15, -5, 0, 5, 15]]:
//
//                                    |   |   |   |   |
//  if first dataset selected     [   0, 10, 20, 30  ]
//    index returned is:            0 | 1 | 2 | 3 | 4 |
//                                    |   |   |   |   |
//                                    |
// Note: if value is EXACTLY 0, feature is entirely omitted
//                                    |
//                                    |
//                                undefined
//
//  if 2nd dataset selected       [ -15, -5,  0,  5, 15]
//    index returned is:            0 | 1 | 2 | 3 | 4 | 5
//                                    |   |   |   |   |
//                                            |
// Note: if value is EXACTLY 0, feature is entirely omitted
//                                            |
//                                            |
//                                       undefined
//


const getBucketIndex = (breaks, value) => {
  let currentBucketIndex;
  if (isNaN(value)) return 0;

  for (let bucketIndex = 0; bucketIndex < breaks.length + 1; bucketIndex++) {
    const stopValue = breaks[bucketIndex] !== undefined ? breaks[bucketIndex] : Number.POSITIVE_INFINITY;

    if (value <= stopValue) {
      currentBucketIndex = bucketIndex;
      break;
    }
  }

  if (currentBucketIndex === undefined) {
    currentBucketIndex = breaks.length;
  }

  return currentBucketIndex;
};

const getValue = (realValuesSum, breaks) => {
  if (realValuesSum === 0) return undefined;
  return breaks ? getBucketIndex(breaks[0], realValuesSum) : realValuesSum;
};

const getCompareValue = (datasetsHighestRealValue, datasetsHighestRealValueIndex, breaks) => {
  if (datasetsHighestRealValue === 0) return undefined;

  if (breaks) {
    // offset each dataset by 10 + add actual bucket value
    return datasetsHighestRealValueIndex * 10 + getBucketIndex(breaks[datasetsHighestRealValueIndex], datasetsHighestRealValue);
  } else {
    // only useful for debug
    return `${datasetsHighestRealValueIndex};${datasetsHighestRealValue}`;
  }
};

const getBivariateValue = (realValues, breaks) => {
  if (realValues[0] === 0 && realValues[1] === 0) return undefined;

  if (breaks) {
    //  y: datasetB
    //
    //   |    0 | 0
    //   |   --(u)--+---+---+---+
    //   |    0 | 1 | 2 | 3 | 4 |
    //   |      +---+---+---+---+
    //   v      | 5 | 6 | 7 | 8 |
    //          +---+---+---+---+
    //          | 9 | 10| 11| 12|
    //          +---+---+---+---+
    //          | 13| 14| 15| 16|
    //          +---+---+---+---+
    //          --------------> x: datasetA
    //
    const valueA = getBucketIndex(breaks[0], realValues[0]);
    const valueB = getBucketIndex(breaks[1], realValues[1]); // || 1: We never want a bucket of 0 - values below first break are not used in bivariate

    const colIndex = (valueA || 1) - 1;
    const rowIndex = (valueB || 1) - 1;
    const index = rowIndex * 4 + colIndex; // offset by one because values start at 1 (0 reserved for values < min value)

    return index + 1;
  } else {
    // only useful for debug
    return `${realValues[0]};${realValues[1]}`;
  }
};

const getTimeCompareValue = (realValues, breaks) => {
  const delta = realValues[1] - realValues[0];
  if (delta === 0) return undefined;

  if (breaks) {
    return getBucketIndex(breaks[0], delta);
  }

  return delta;
};

const getCumulativeValue = (realValuesSum, cumulativeValuesPaddedStrings) => {
  if (realValuesSum === 0) return undefined;
  return cumulativeValuesPaddedStrings.join('');
};

const err = msg => {
  console.error('4w-agg::', msg);
  throw new Error(`4w-agg::${msg}`);
};

function aggregate(intArray, options) {
  const {
    quantizeOffset = 0,
    tileBBox,
    x,
    y,
    delta = 30,
    geomType = GeomType.rectangle,
    singleFrame,
    interactive,
    sublayerBreaks,
    sublayerCount,
    sublayerCombinationMode,
    sublayerVisibility,
    aggregationOperation
  } = options;

  if (sublayerCombinationMode === SublayerCombinationMode.None && sublayerCount > 1) {
    err('Multiple sublayers but no proper combination mode set');
  }

  if (sublayerBreaks && sublayerBreaks.length !== sublayerCount && (sublayerCombinationMode === SublayerCombinationMode.Max || sublayerCombinationMode === SublayerCombinationMode.Bivariate)) {
    err('must provide as many breaks arrays as number of datasets when using compare and bivariate modes');
  }

  if (sublayerCombinationMode === SublayerCombinationMode.TimeCompare) {
    if (sublayerCount !== 2) err('delta combinationMode requires sublayer count === 2');

    if (sublayerBreaks) {
      if (sublayerBreaks.length !== 1) err('delta combinationMode requires exactly one breaks array to generate a diverging scale');
    }
  }

  if (sublayerBreaks && sublayerBreaks.length !== 1 && sublayerCombinationMode === SublayerCombinationMode.Add) {
    err('add combinationMode requires one and only one breaks array');
  }

  if (sublayerCombinationMode === SublayerCombinationMode.Bivariate) {
    if (sublayerCount !== 2) err('bivariate combinationMode requires exactly two datasets');

    if (sublayerBreaks) {
      if (sublayerBreaks.length !== 2) err('bivariate combinationMode requires exactly two breaks array');
      if (sublayerBreaks[0].length !== sublayerBreaks[1].length) err('bivariate breaks arrays must have the same length'); // TODO This might change if we want bivariate with more or less than 16 classes

      if (sublayerBreaks[0].length !== 4 || sublayerBreaks[1].length !== 4) err('each bivariate breaks array require exactly 4 values');
    }
  }

  const features = [];
  const featuresInteractive = [];
  let aggregating = Array(sublayerCount).fill([]);
  let currentAggregatedValues = Array(sublayerCount).fill(0);
  let currentAggregatedValuesLength = 0;
  let currentFeature;
  let currentFeatureInteractive;
  let currentFeatureCell;
  let currentFeatureMinTimestamp;
  let featureBufferValuesPos = 0;
  let head;
  let tail;
  let datasetsHighestRealValue = Number.NEGATIVE_INFINITY;
  let datasetsHighestRealValueIndex;
  let realValuesSum = 0;
  let literalValuesStr = '[';
  let cumulativeValuesPaddedStrings = [];
  const numRows = intArray[FEATURE_ROW_INDEX];
  const numCols = intArray[FEATURE_COL_INDEX];
  const featureIntArrays = [];
  let startFrame = 0;
  let endFrame = 0;
  let startIndex = 0;
  let endIndex = 0;
  let indexInCell = 0; // We need to pad with n values (n === delta) to generate "overflow" frames
  // in the case of a sum, add zeroes which will get added to the running sunm with no effect
  // in the case of avg, us NaN as a flag to not take the value into account

  const padValue = aggregationOperation === AggregationOperation.Avg ? NaN : 0;

  for (let i = FEATURE_CELLS_START_INDEX; i < intArray.length; i++) {
    const value = intArray[i];

    if (indexInCell === CELL_NUM_INDEX) {
      startIndex = i;
    } else if (indexInCell === CELL_START_INDEX) {
      startFrame = value;
    } else if (indexInCell === CELL_END_INDEX) {
      endFrame = value;
      endIndex = startIndex + CELL_VALUES_START_INDEX + (endFrame - startFrame + 1) * sublayerCount;
    }

    indexInCell++;

    if (i === endIndex - 1) {
      indexInCell = 0;
      const original = intArray.slice(startIndex, endIndex);
      const padded = new Array(delta * sublayerCount).fill(padValue); // TODO Are we sure we want to use FEATURE_CELLS_START_INDEX, not CELL_START_INDEX??

      original[FEATURE_CELLS_START_INDEX] = endFrame + delta;
      const merged = original.concat(padded);
      featureIntArrays.push(merged);
    }
  }

  if (singleFrame) {
    for (let i = 2; i < intArray.length; i++) {
      const value = intArray[i];

      if (i % 2 === 0) {
        currentFeatureCell = value;
      } else {
        const uniqueId = generateUniqueId(x, y, currentFeatureCell);
        const featureParams = {
          geomType,
          tileBBox,
          cell: currentFeatureCell,
          numCols,
          numRows,
          id: uniqueId
        };
        currentFeature = getFeature(featureParams);
        currentFeature.properties.value = value / VALUE_MULTIPLIER;
        features.push(currentFeature);
      }
    }
  } else {
    for (let f = 0; f < featureIntArrays.length; f++) {
      const featureIntArray = featureIntArrays[f];
      currentFeatureCell = featureIntArray[CELL_NUM_INDEX];
      currentFeatureMinTimestamp = featureIntArray[CELL_START_INDEX];
      head = currentFeatureMinTimestamp;
      const uniqueId = generateUniqueId(x, y, currentFeatureCell);
      const featureParams = {
        geomType,
        tileBBox,
        cell: currentFeatureCell,
        numCols,
        numRows,
        id: uniqueId,
        addMeta: true
      };
      currentFeature = getFeature(featureParams);

      if (interactive) {
        currentFeatureInteractive = getFeature(Object.assign(Object.assign({}, featureParams), {
          addMeta: true
        }));
      }

      for (let i = CELL_VALUES_START_INDEX; i < featureIntArray.length; i++) {
        const value = featureIntArray[i]; // when we are looking at ts 0 and delta is 10, we are in fact looking at the aggregation of day -9

        tail = head - delta + 1; // gets index of dataset, knowing that after headers values go
        // dataset1, dataset2, dataset1, dataset2, ...

        const datasetIndex = featureBufferValuesPos % sublayerCount; // collect value for this dataset

        aggregating[datasetIndex].push(value);
        let tailValue = 0;

        if (tail > currentFeatureMinTimestamp) {
          tailValue = aggregating[datasetIndex].shift();
        }

        const skipFrame = isNaN(value) || value === 0;

        if (currentAggregatedValuesLength < delta && !skipFrame) {
          currentAggregatedValuesLength++;
        } // collect "working" value, ie value at head by substracting tail value


        let realValueAtFrameForDataset = 0;
        let realValueAtFrameForDatasetWorkingValue = 0;

        if (sublayerVisibility[datasetIndex]) {
          if (aggregationOperation === AggregationOperation.Avg) {
            // if isNaN, value is just for padding - stop incrementing running sum (just remove tail)
            // and take into account one less frame to compute the avg
            realValueAtFrameForDatasetWorkingValue = skipFrame ? currentAggregatedValues[datasetIndex] - tailValue : currentAggregatedValues[datasetIndex] + value - tailValue;

            if (skipFrame && currentAggregatedValuesLength > 0 && tailValue > 0) {
              currentAggregatedValuesLength--;
            }

            realValueAtFrameForDataset = currentAggregatedValuesLength > 0 ? realValueAtFrameForDatasetWorkingValue / currentAggregatedValuesLength : realValueAtFrameForDatasetWorkingValue;
          } else {
            realValueAtFrameForDataset = realValueAtFrameForDatasetWorkingValue = currentAggregatedValues[datasetIndex] + value - tailValue;
          }
        }

        currentAggregatedValues[datasetIndex] = realValueAtFrameForDatasetWorkingValue; // Compute mode-specific values

        if (sublayerCombinationMode === SublayerCombinationMode.Max) {
          if (realValueAtFrameForDataset > datasetsHighestRealValue) {
            datasetsHighestRealValue = realValueAtFrameForDataset;
            datasetsHighestRealValueIndex = datasetIndex;
          }
        }

        if (sublayerCombinationMode === SublayerCombinationMode.Add || sublayerCombinationMode === SublayerCombinationMode.Cumulative) {
          realValuesSum += realValueAtFrameForDataset;
        }

        if (sublayerCombinationMode === SublayerCombinationMode.Cumulative) {
          const cumulativeValuePaddedString = Math.round(realValuesSum).toString().padStart(6, '0');
          cumulativeValuesPaddedStrings.push(cumulativeValuePaddedString);
        }

        if (sublayerCombinationMode === SublayerCombinationMode.Literal) {
          // literalValuesStr += Math.floor(realValueAtFrameForDataset * 100) / 100
          // Just rounding is faster - revise if decimals are needed
          // Use ceil to avoid values being 'mute' when very close to zero
          // Update: use .round to avoid discrepancies betwen interaction and total ammount
          literalValuesStr += Math.round(realValueAtFrameForDataset);

          if (datasetIndex < sublayerCount - 1) {
            literalValuesStr += ',';
          }
        }

        const quantizedTail = tail - quantizeOffset;

        if (quantizedTail >= 0 && datasetIndex === sublayerCount - 1) {
          let finalValue;

          if (sublayerCombinationMode === SublayerCombinationMode.Literal) {
            literalValuesStr += ']';
          }

          if (sublayerCombinationMode === SublayerCombinationMode.None) {
            finalValue = getValue(realValueAtFrameForDataset, sublayerBreaks);
          } else if (sublayerCombinationMode === SublayerCombinationMode.Max) {
            finalValue = getCompareValue(datasetsHighestRealValue, datasetsHighestRealValueIndex, sublayerBreaks);
          } else if (sublayerCombinationMode === SublayerCombinationMode.Add) {
            finalValue = getValue(realValuesSum, sublayerBreaks);
          } else if (sublayerCombinationMode === SublayerCombinationMode.Bivariate) {
            finalValue = getBivariateValue(currentAggregatedValues, sublayerBreaks);
          } else if (sublayerCombinationMode === SublayerCombinationMode.TimeCompare) {
            finalValue = getTimeCompareValue(currentAggregatedValues, sublayerBreaks);
          } else if (sublayerCombinationMode === SublayerCombinationMode.Literal) {
            finalValue = literalValuesStr;
          } else if (sublayerCombinationMode === SublayerCombinationMode.Cumulative) {
            finalValue = getCumulativeValue(realValuesSum, cumulativeValuesPaddedStrings);
          }

          writeValueToFeature(quantizedTail, finalValue, currentFeature);
        }

        if (datasetIndex === sublayerCount - 1) {
          // When all dataset values have been collected for this frame, we can move to next frame
          head++; // Reset mode-specific values when last dataset

          datasetsHighestRealValue = Number.NEGATIVE_INFINITY;
          realValuesSum = 0;
          cumulativeValuesPaddedStrings = [];
          literalValuesStr = '[';
        }

        featureBufferValuesPos++;
      }

      features.push(currentFeature);

      if (interactive) {
        currentFeatureInteractive.properties.rawValues = featureIntArray;
        featuresInteractive.push(currentFeatureInteractive);
      }

      featureBufferValuesPos = 0;
      datasetsHighestRealValue = Number.NEGATIVE_INFINITY;
      realValuesSum = 0;
      cumulativeValuesPaddedStrings = [];
      aggregating = Array(sublayerCount).fill([]);
      currentAggregatedValues = Array(sublayerCount).fill(0);
      continue;
    }
  }

  const geoJSONs = {
    main: {
      type: 'FeatureCollection',
      features
    }
  };

  if (interactive) {
    geoJSONs.interactive = {
      type: 'FeatureCollection',
      features: featuresInteractive
    };
  }

  return geoJSONs;
}

const getTimeSeries = (features, numSublayers, quantizeOffset = 0, aggregationOperation = AggregationOperation.Sum) => {
  var _a;

  let minFrame = Number.POSITIVE_INFINITY;
  let maxFrame = Number.NEGATIVE_INFINITY;

  if (!features || !features.length) {
    return {
      values: [],
      minFrame,
      maxFrame
    };
  }

  const valuesByFrame = [];
  features.forEach(feature => {
    const rawValues = feature.properties.rawValues;
    const {
      values,
      minCellOffset
    } = getCellValues(rawValues);
    if (minCellOffset < minFrame) minFrame = minCellOffset;
    let currentFrameIndex = minCellOffset;
    let offsetedCurrentFrameIndex = minCellOffset - quantizeOffset;

    for (let i = CELL_VALUES_START_INDEX; i < values.length; i++) {
      const sublayerIndex = (i - CELL_VALUES_START_INDEX) % numSublayers;
      const rawValue = values[i];

      if (rawValue !== null && !isNaN(rawValue)) {
        if (currentFrameIndex > maxFrame) maxFrame = currentFrameIndex;

        if (!valuesByFrame[offsetedCurrentFrameIndex]) {
          valuesByFrame[offsetedCurrentFrameIndex] = {
            sublayersValues: new Array(numSublayers).fill(0),
            numValues: 0
          };
        }

        valuesByFrame[offsetedCurrentFrameIndex].sublayersValues[sublayerIndex] += rawValue;

        if (sublayerIndex === numSublayers - 1) {
          // assuming that if last sublayer value !isNaN, other sublayer values too
          valuesByFrame[offsetedCurrentFrameIndex].numValues++;
        }
      }

      if (sublayerIndex === numSublayers - 1) {
        offsetedCurrentFrameIndex++;
        currentFrameIndex++;
      }
    }
  });
  const numValues = maxFrame - minFrame;
  const finalValues = new Array(numValues);

  for (let i = 0; i <= numValues; i++) {
    const frame = minFrame + i;
    const frameValues = (_a = valuesByFrame[frame - quantizeOffset]) !== null && _a !== void 0 ? _a : {
      sublayersValues: new Array(numSublayers).fill(0),
      numValues: 0
    };
    let sublayersValues;

    if (frameValues) {
      sublayersValues = frameValues.sublayersValues;

      if (aggregationOperation === AggregationOperation.Avg) {
        sublayersValues = sublayersValues.map(sublayerValue => sublayerValue / frameValues.numValues);
      }
    }

    finalValues[i] = Object.assign({
      frame
    }, sublayersValues);
  }

  return {
    values: finalValues,
    minFrame,
    maxFrame
  };
};

'use strict';

var d2r = Math.PI / 180,
    r2d = 180 / Math.PI;

/**
 * Get the bbox of a tile
 *
 * @name tileToBBOX
 * @param {Array<number>} tile
 * @returns {Array<number>} bbox
 * @example
 * var bbox = tileToBBOX([5, 10, 10])
 * //=bbox
 */
function tileToBBOX(tile) {
    var e = tile2lon(tile[0] + 1, tile[2]);
    var w = tile2lon(tile[0], tile[2]);
    var s = tile2lat(tile[1] + 1, tile[2]);
    var n = tile2lat(tile[1], tile[2]);
    return [w, s, e, n];
}

/**
 * Get a geojson representation of a tile
 *
 * @name tileToGeoJSON
 * @param {Array<number>} tile
 * @returns {Feature<Polygon>}
 * @example
 * var poly = tileToGeoJSON([5, 10, 10])
 * //=poly
 */
function tileToGeoJSON(tile) {
    var bbox = tileToBBOX(tile);
    var poly = {
        type: 'Polygon',
        coordinates: [[
            [bbox[0], bbox[3]],
            [bbox[0], bbox[1]],
            [bbox[2], bbox[1]],
            [bbox[2], bbox[3]],
            [bbox[0], bbox[3]]
        ]]
    };
    return poly;
}

function tile2lon(x, z) {
    return x / Math.pow(2, z) * 360 - 180;
}

function tile2lat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return r2d * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Get the tile for a point at a specified zoom level
 *
 * @name pointToTile
 * @param {number} lon
 * @param {number} lat
 * @param {number} z
 * @returns {Array<number>} tile
 * @example
 * var tile = pointToTile(1, 1, 20)
 * //=tile
 */
function pointToTile(lon, lat, z) {
    var tile = pointToTileFraction(lon, lat, z);
    tile[0] = Math.floor(tile[0]);
    tile[1] = Math.floor(tile[1]);
    return tile;
}

/**
 * Get the 4 tiles one zoom level higher
 *
 * @name getChildren
 * @param {Array<number>} tile
 * @returns {Array<Array<number>>} tiles
 * @example
 * var tiles = getChildren([5, 10, 10])
 * //=tiles
 */
function getChildren(tile) {
    return [
        [tile[0] * 2, tile[1] * 2, tile[2] + 1],
        [tile[0] * 2 + 1, tile[1] * 2, tile[2 ] + 1],
        [tile[0] * 2 + 1, tile[1] * 2 + 1, tile[2] + 1],
        [tile[0] * 2, tile[1] * 2 + 1, tile[2] + 1]
    ];
}

/**
 * Get the tile one zoom level lower
 *
 * @name getParent
 * @param {Array<number>} tile
 * @returns {Array<number>} tile
 * @example
 * var tile = getParent([5, 10, 10])
 * //=tile
 */
function getParent(tile) {
    return [tile[0] >> 1, tile[1] >> 1, tile[2] - 1];
}

function getSiblings(tile) {
    return getChildren(getParent(tile));
}

/**
 * Get the 3 sibling tiles for a tile
 *
 * @name getSiblings
 * @param {Array<number>} tile
 * @returns {Array<Array<number>>} tiles
 * @example
 * var tiles = getSiblings([5, 10, 10])
 * //=tiles
 */
function hasSiblings(tile, tiles) {
    var siblings = getSiblings(tile);
    for (var i = 0; i < siblings.length; i++) {
        if (!hasTile(tiles, siblings[i])) return false;
    }
    return true;
}

/**
 * Check to see if an array of tiles contains a particular tile
 *
 * @name hasTile
 * @param {Array<Array<number>>} tiles
 * @param {Array<number>} tile
 * @returns {boolean}
 * @example
 * var tiles = [
 *     [0, 0, 5],
 *     [0, 1, 5],
 *     [1, 1, 5],
 *     [1, 0, 5]
 * ]
 * hasTile(tiles, [0, 0, 5])
 * //=boolean
 */
function hasTile(tiles, tile) {
    for (var i = 0; i < tiles.length; i++) {
        if (tilesEqual(tiles[i], tile)) return true;
    }
    return false;
}

/**
 * Check to see if two tiles are the same
 *
 * @name tilesEqual
 * @param {Array<number>} tile1
 * @param {Array<number>} tile2
 * @returns {boolean}
 * @example
 * tilesEqual([0, 1, 5], [0, 0, 5])
 * //=boolean
 */
function tilesEqual(tile1, tile2) {
    return (
        tile1[0] === tile2[0] &&
        tile1[1] === tile2[1] &&
        tile1[2] === tile2[2]
    );
}

/**
 * Get the quadkey for a tile
 *
 * @name tileToQuadkey
 * @param {Array<number>} tile
 * @returns {string} quadkey
 * @example
 * var quadkey = tileToQuadkey([0, 1, 5])
 * //=quadkey
 */
function tileToQuadkey(tile) {
    var index = '';
    for (var z = tile[2]; z > 0; z--) {
        var b = 0;
        var mask = 1 << (z - 1);
        if ((tile[0] & mask) !== 0) b++;
        if ((tile[1] & mask) !== 0) b += 2;
        index += b.toString();
    }
    return index;
}

/**
 * Get the tile for a quadkey
 *
 * @name quadkeyToTile
 * @param {string} quadkey
 * @returns {Array<number>} tile
 * @example
 * var tile = quadkeyToTile('00001033')
 * //=tile
 */
function quadkeyToTile(quadkey) {
    var x = 0;
    var y = 0;
    var z = quadkey.length;

    for (var i = z; i > 0; i--) {
        var mask = 1 << (i - 1);
        var q = +quadkey[z - i];
        if (q === 1) x |= mask;
        if (q === 2) y |= mask;
        if (q === 3) {
            x |= mask;
            y |= mask;
        }
    }
    return [x, y, z];
}

/**
 * Get the smallest tile to cover a bbox
 *
 * @name bboxToTile
 * @param {Array<number>} bbox
 * @returns {Array<number>} tile
 * @example
 * var tile = bboxToTile([ -178, 84, -177, 85 ])
 * //=tile
 */
function bboxToTile(bboxCoords) {
    var min = pointToTile(bboxCoords[0], bboxCoords[1], 32);
    var max = pointToTile(bboxCoords[2], bboxCoords[3], 32);
    var bbox = [min[0], min[1], max[0], max[1]];

    var z = getBboxZoom(bbox);
    if (z === 0) return [0, 0, 0];
    var x = bbox[0] >>> (32 - z);
    var y = bbox[1] >>> (32 - z);
    return [x, y, z];
}

function getBboxZoom(bbox) {
    var MAX_ZOOM = 28;
    for (var z = 0; z < MAX_ZOOM; z++) {
        var mask = 1 << (32 - (z + 1));
        if (((bbox[0] & mask) !== (bbox[2] & mask)) ||
            ((bbox[1] & mask) !== (bbox[3] & mask))) {
            return z;
        }
    }

    return MAX_ZOOM;
}

/**
 * Get the precise fractional tile location for a point at a zoom level
 *
 * @name pointToTileFraction
 * @param {number} lon
 * @param {number} lat
 * @param {number} z
 * @returns {Array<number>} tile fraction
 * var tile = pointToTileFraction(30.5, 50.5, 15)
 * //=tile
 */
function pointToTileFraction(lon, lat, z) {
    var sin = Math.sin(lat * d2r),
        z2 = Math.pow(2, z),
        x = z2 * (lon / 360 + 0.5),
        y = z2 * (0.5 - 0.25 * Math.log((1 + sin) / (1 - sin)) / Math.PI);

    // Wrap Tile X
    x = x % z2;
    if (x < 0) x = x + z2;
    return [x, y, z];
}

var tilebelt = {
    tileToGeoJSON: tileToGeoJSON,
    tileToBBOX: tileToBBOX,
    getChildren: getChildren,
    getParent: getParent,
    getSiblings: getSiblings,
    hasTile: hasTile,
    hasSiblings: hasSiblings,
    tilesEqual: tilesEqual,
    tileToQuadkey: tileToQuadkey,
    quadkeyToTile: quadkeyToTile,
    pointToTile: pointToTile,
    bboxToTile: bboxToTile,
    pointToTileFraction: pointToTileFraction
};

/* eslint-disable camelcase */
const objectEntries = Object.entries ||
    function (obj) {
        const ownProps = Object.keys(obj);
        let i = ownProps.length;
        const resArray = new Array(i); // preallocate the Array
        while (i--)
            resArray[i] = [ownProps[i], obj[ownProps[i]]];
        return resArray;
    };
const objectFromEntries = Object.fromEntries ||
    function (entries) {
        if (!entries || !entries[Symbol.iterator]) {
            throw new Error('Object.fromEntries() requires a single iterable argument');
        }
        const obj = {};
        for (const [key, value] of entries) {
            obj[key] = value;
        }
        return obj;
    };
class SearchParams {
    constructor(query) {
        this.query = query;
    }
    getSearchObject() {
        const { query } = this;
        return query ?
            (/^[?#]/.test(query) ? query.slice(1) : query).split('&').reduce((params, param) => {
                const [key, value] = param.split('=');
                params[key] = value ? decodeURIComponent(value.replace(/\+/g, ' ')) : '';
                return params;
            }, {}) :
            {};
    }
    get(param) {
        const searchParams = this.getSearchObject();
        return searchParams[param];
    }
}
const getAggregationParams = (params) => {
    const url = new URL(params.request.url);
    const searchParams = url.searchParams;
    let finalParams;
    if (searchParams) {
        finalParams = Object.fromEntries(searchParams);
    }
    else {
        finalParams = new SearchParams(params.request.url).getSearchObject();
    }
    const { x, y, z } = params.tileID.canonical;
    const { interval, aggregationOperation, sublayerCombinationMode } = finalParams;
    const aggregationParams = {
        x,
        y,
        z,
        interval,
        aggregationOperation,
        sublayerCombinationMode,
        singleFrame: finalParams.singleFrame === 'true',
        interactive: finalParams.interactive === 'true',
        quantizeOffset: parseInt(finalParams.quantizeOffset || '0'),
        geomType: finalParams.geomType || 'point',
        delta: parseInt(finalParams.delta) || '10',
        sublayerCount: parseInt(finalParams.sublayerCount) || 1,
        sublayerBreaks: finalParams.sublayerBreaks ? JSON.parse(finalParams.sublayerBreaks) : null,
        sublayerVisibility: finalParams.sublayerVisibility ?
            JSON.parse(finalParams.sublayerVisibility) :
            new Array(finalParams.sublayerCount).fill(true)
    };
    return objectFromEntries(objectEntries(aggregationParams).filter(([_, value]) => {
        return value !== undefined && value !== null;
    }));
};
const OMITTED_URL_PARAMS = [
    'aggregationOperation',
    'delta',
    'geomType',
    'id',
    'interactive',
    'quantizeOffset',
    'singleFrame',
    'sublayerBreaks',
    'sublayerCombinationMode',
    'sublayerCount',
    'sublayerVisibility',
];
const getFinalurl = (originalUrlString) => {
    const originalUrl = new URL(originalUrlString);
    let searchParams = originalUrl.searchParams;
    if (!searchParams) {
        searchParams = new SearchParams(originalUrlString);
    }
    OMITTED_URL_PARAMS.forEach((param) => {
        if (searchParams.get(param)) {
            searchParams.delete(param);
        }
    });
    const finalUrlStr = `${originalUrl.origin}${originalUrl.pathname}?${searchParams.toString()}`;
    return decodeURI(finalUrlStr);
};
const geoJSONtoVectorTile = (geoJSON, options) => {
    const { x, y, z } = options;
    const tileindex = geojsonvt(geoJSON);
    const newTile = tileindex.getTile(z, x, y);
    return newTile;
};
const decodeProto = (data) => {
    const readField = function (tag, obj, pbf) {
        if (tag === 1)
            pbf.readPackedVarint(obj.data);
    };
    const read = function (pbf, end) {
        return pbf.readFields(readField, { data: [] }, end);
    };
    const pbfData = new performance.pbf(data);
    const intArray = read(pbfData);
    return intArray && intArray.data;
};
const getTile = (data, options) => {
    const { x, y, z } = options;
    const tileBBox = tilebelt.tileToBBOX([x, y, z]);
    const int16ArrayBuffer = decodeProto(data);
    const aggregated = aggregate(int16ArrayBuffer, Object.assign(Object.assign({}, options), { tileBBox }));
    const mainTile = geoJSONtoVectorTile(aggregated.main, options);
    const sourceLayers = {
        temporalgrid: mainTile
    };
    if (options.interactive === true) {
        const interactiveTile = geoJSONtoVectorTile(aggregated.interactive, options);
        sourceLayers.temporalgrid_interactive = interactiveTile;
    }
    const geojsonWrapper = new MultiSourceLayerGeoJSONWrapper(sourceLayers, {
        extent: 4096
    });
    let pbf = vtpbf.fromGeojsonVt(sourceLayers);
    if (pbf.byteOffset !== 0 || pbf.byteLength !== pbf.buffer.byteLength) {
        // Compatibility with node Buffer (https://github.com/mapbox/pbf/issues/35)
        pbf = new Uint8Array(pbf);
    }
    return {
        vectorTile: geojsonWrapper,
        rawData: pbf.buffer
    };
};
const loadVectorData = (params, callback) => {
    const aggregationParams = getAggregationParams(params);
    const url = getFinalurl(params.request.url);
    // console.log(url)
    const requestParams = performance.extend(params.request, { url });
    const request = performance.getArrayBuffer(requestParams, (err, data, cacheControl, expires) => {
        if (err) {
            callback(err);
        }
        else if (data) {
            const tile = getTile(data, aggregationParams);
            callback(null, Object.assign(Object.assign({}, tile), { cacheControl,
                expires }));
        }
    });
    return () => {
        request.cancel();
        callback();
    };
};
class TemporalGridTileWorkerSource extends VectorTileWorkerSource {
    constructor(actor, layerIndex, availableImages) {
        super(actor, layerIndex, availableImages, loadVectorData);
    }
}

class RasterDEMTileWorkerSource {
    constructor() {
        this.loaded = {};
    }
    loadTile(params, callback) {
        const { uid, encoding, rawImageData } = params;
        // Main thread will transfer ImageBitmap if offscreen decode with OffscreenCanvas is supported, else it will transfer an already decoded image.
        const imagePixels = performance.isImageBitmap(rawImageData) ? this.getImageData(rawImageData) : rawImageData;
        const dem = new performance.DEMData(uid, imagePixels, encoding);
        this.loaded = this.loaded || {};
        this.loaded[uid] = dem;
        callback(null, dem);
    }
    getImageData(imgBitmap) {
        // Lazily initialize OffscreenCanvas
        if (!this.offscreenCanvas || !this.offscreenCanvasContext) {
            // Dem tiles are typically 256x256
            this.offscreenCanvas = new OffscreenCanvas(imgBitmap.width, imgBitmap.height);
            this.offscreenCanvasContext = this.offscreenCanvas.getContext('2d');
        }
        this.offscreenCanvas.width = imgBitmap.width;
        this.offscreenCanvas.height = imgBitmap.height;
        this.offscreenCanvasContext.drawImage(imgBitmap, 0, 0, imgBitmap.width, imgBitmap.height);
        // Insert an additional 1px padding around the image to allow backfilling for neighboring data.
        const imgData = this.offscreenCanvasContext.getImageData(-1, -1, imgBitmap.width + 2, imgBitmap.height + 2);
        this.offscreenCanvasContext.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
        return new performance.RGBAImage({ width: imgData.width, height: imgData.height }, imgData.data);
    }
    removeTile(params) {
        const loaded = this.loaded, uid = params.uid;
        if (loaded && loaded[uid]) {
            delete loaded[uid];
        }
    }
}

var geojsonRewind = rewind;

function rewind(gj, outer) {
    var type = gj && gj.type, i;

    if (type === 'FeatureCollection') {
        for (i = 0; i < gj.features.length; i++) rewind(gj.features[i], outer);

    } else if (type === 'GeometryCollection') {
        for (i = 0; i < gj.geometries.length; i++) rewind(gj.geometries[i], outer);

    } else if (type === 'Feature') {
        rewind(gj.geometry, outer);

    } else if (type === 'Polygon') {
        rewindRings(gj.coordinates, outer);

    } else if (type === 'MultiPolygon') {
        for (i = 0; i < gj.coordinates.length; i++) rewindRings(gj.coordinates[i], outer);
    }

    return gj;
}

function rewindRings(rings, outer) {
    if (rings.length === 0) return;

    rewindRing(rings[0], outer);
    for (var i = 1; i < rings.length; i++) {
        rewindRing(rings[i], !outer);
    }
}

function rewindRing(ring, dir) {
    var area = 0, err = 0;
    for (var i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
        var k = (ring[i][0] - ring[j][0]) * (ring[j][1] + ring[i][1]);
        var m = area + k;
        err += Math.abs(area) >= Math.abs(k) ? area - m + k : k - m + area;
        area = m;
    }
    if (area + err >= 0 !== !!dir) ring.reverse();
}

function sortKD(ids, coords, nodeSize, left, right, depth) {
    if (right - left <= nodeSize) return;

    const m = (left + right) >> 1;

    select(ids, coords, m, left, right, depth % 2);

    sortKD(ids, coords, nodeSize, left, m - 1, depth + 1);
    sortKD(ids, coords, nodeSize, m + 1, right, depth + 1);
}

function select(ids, coords, k, left, right, inc) {

    while (right > left) {
        if (right - left > 600) {
            const n = right - left + 1;
            const m = k - left + 1;
            const z = Math.log(n);
            const s = 0.5 * Math.exp(2 * z / 3);
            const sd = 0.5 * Math.sqrt(z * s * (n - s) / n) * (m - n / 2 < 0 ? -1 : 1);
            const newLeft = Math.max(left, Math.floor(k - m * s / n + sd));
            const newRight = Math.min(right, Math.floor(k + (n - m) * s / n + sd));
            select(ids, coords, k, newLeft, newRight, inc);
        }

        const t = coords[2 * k + inc];
        let i = left;
        let j = right;

        swapItem(ids, coords, left, k);
        if (coords[2 * right + inc] > t) swapItem(ids, coords, left, right);

        while (i < j) {
            swapItem(ids, coords, i, j);
            i++;
            j--;
            while (coords[2 * i + inc] < t) i++;
            while (coords[2 * j + inc] > t) j--;
        }

        if (coords[2 * left + inc] === t) swapItem(ids, coords, left, j);
        else {
            j++;
            swapItem(ids, coords, j, right);
        }

        if (j <= k) left = j + 1;
        if (k <= j) right = j - 1;
    }
}

function swapItem(ids, coords, i, j) {
    swap(ids, i, j);
    swap(coords, 2 * i, 2 * j);
    swap(coords, 2 * i + 1, 2 * j + 1);
}

function swap(arr, i, j) {
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
}

function range(ids, coords, minX, minY, maxX, maxY, nodeSize) {
    const stack = [0, ids.length - 1, 0];
    const result = [];
    let x, y;

    while (stack.length) {
        const axis = stack.pop();
        const right = stack.pop();
        const left = stack.pop();

        if (right - left <= nodeSize) {
            for (let i = left; i <= right; i++) {
                x = coords[2 * i];
                y = coords[2 * i + 1];
                if (x >= minX && x <= maxX && y >= minY && y <= maxY) result.push(ids[i]);
            }
            continue;
        }

        const m = Math.floor((left + right) / 2);

        x = coords[2 * m];
        y = coords[2 * m + 1];

        if (x >= minX && x <= maxX && y >= minY && y <= maxY) result.push(ids[m]);

        const nextAxis = (axis + 1) % 2;

        if (axis === 0 ? minX <= x : minY <= y) {
            stack.push(left);
            stack.push(m - 1);
            stack.push(nextAxis);
        }
        if (axis === 0 ? maxX >= x : maxY >= y) {
            stack.push(m + 1);
            stack.push(right);
            stack.push(nextAxis);
        }
    }

    return result;
}

function within(ids, coords, qx, qy, r, nodeSize) {
    const stack = [0, ids.length - 1, 0];
    const result = [];
    const r2 = r * r;

    while (stack.length) {
        const axis = stack.pop();
        const right = stack.pop();
        const left = stack.pop();

        if (right - left <= nodeSize) {
            for (let i = left; i <= right; i++) {
                if (sqDist(coords[2 * i], coords[2 * i + 1], qx, qy) <= r2) result.push(ids[i]);
            }
            continue;
        }

        const m = Math.floor((left + right) / 2);

        const x = coords[2 * m];
        const y = coords[2 * m + 1];

        if (sqDist(x, y, qx, qy) <= r2) result.push(ids[m]);

        const nextAxis = (axis + 1) % 2;

        if (axis === 0 ? qx - r <= x : qy - r <= y) {
            stack.push(left);
            stack.push(m - 1);
            stack.push(nextAxis);
        }
        if (axis === 0 ? qx + r >= x : qy + r >= y) {
            stack.push(m + 1);
            stack.push(right);
            stack.push(nextAxis);
        }
    }

    return result;
}

function sqDist(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}

const defaultGetX = p => p[0];
const defaultGetY = p => p[1];

class KDBush {
    constructor(points, getX = defaultGetX, getY = defaultGetY, nodeSize = 64, ArrayType = Float64Array) {
        this.nodeSize = nodeSize;
        this.points = points;

        const IndexArrayType = points.length < 65536 ? Uint16Array : Uint32Array;

        const ids = this.ids = new IndexArrayType(points.length);
        const coords = this.coords = new ArrayType(points.length * 2);

        for (let i = 0; i < points.length; i++) {
            ids[i] = i;
            coords[2 * i] = getX(points[i]);
            coords[2 * i + 1] = getY(points[i]);
        }

        sortKD(ids, coords, nodeSize, 0, ids.length - 1, 0);
    }

    range(minX, minY, maxX, maxY) {
        return range(this.ids, this.coords, minX, minY, maxX, maxY, this.nodeSize);
    }

    within(x, y, r) {
        return within(this.ids, this.coords, x, y, r, this.nodeSize);
    }
}

const defaultOptions = {
    minZoom: 0,   // min zoom to generate clusters on
    maxZoom: 16,  // max zoom level to cluster the points on
    minPoints: 2, // minimum points to form a cluster
    radius: 40,   // cluster radius in pixels
    extent: 512,  // tile extent (radius is calculated relative to it)
    nodeSize: 64, // size of the KD-tree leaf node, affects performance
    log: false,   // whether to log timing info

    // whether to generate numeric ids for input features (in vector tiles)
    generateId: false,

    // a reduce function for calculating custom cluster properties
    reduce: null, // (accumulated, props) => { accumulated.sum += props.sum; }

    // properties to use for individual points when running the reducer
    map: props => props // props => ({sum: props.my_value})
};

const fround = Math.fround || (tmp => ((x) => { tmp[0] = +x; return tmp[0]; }))(new Float32Array(1));

class Supercluster {
    constructor(options) {
        this.options = extend(Object.create(defaultOptions), options);
        this.trees = new Array(this.options.maxZoom + 1);
    }

    load(points) {
        const {log, minZoom, maxZoom, nodeSize} = this.options;

        if (log) console.time('total time');

        const timerId = `prepare ${  points.length  } points`;
        if (log) console.time(timerId);

        this.points = points;

        // generate a cluster object for each point and index input points into a KD-tree
        let clusters = [];
        for (let i = 0; i < points.length; i++) {
            if (!points[i].geometry) continue;
            clusters.push(createPointCluster(points[i], i));
        }
        this.trees[maxZoom + 1] = new KDBush(clusters, getX, getY, nodeSize, Float32Array);

        if (log) console.timeEnd(timerId);

        // cluster points on max zoom, then cluster the results on previous zoom, etc.;
        // results in a cluster hierarchy across zoom levels
        for (let z = maxZoom; z >= minZoom; z--) {
            const now = +Date.now();

            // create a new set of clusters for the zoom and index them with a KD-tree
            clusters = this._cluster(clusters, z);
            this.trees[z] = new KDBush(clusters, getX, getY, nodeSize, Float32Array);

            if (log) console.log('z%d: %d clusters in %dms', z, clusters.length, +Date.now() - now);
        }

        if (log) console.timeEnd('total time');

        return this;
    }

    getClusters(bbox, zoom) {
        let minLng = ((bbox[0] + 180) % 360 + 360) % 360 - 180;
        const minLat = Math.max(-90, Math.min(90, bbox[1]));
        let maxLng = bbox[2] === 180 ? 180 : ((bbox[2] + 180) % 360 + 360) % 360 - 180;
        const maxLat = Math.max(-90, Math.min(90, bbox[3]));

        if (bbox[2] - bbox[0] >= 360) {
            minLng = -180;
            maxLng = 180;
        } else if (minLng > maxLng) {
            const easternHem = this.getClusters([minLng, minLat, 180, maxLat], zoom);
            const westernHem = this.getClusters([-180, minLat, maxLng, maxLat], zoom);
            return easternHem.concat(westernHem);
        }

        const tree = this.trees[this._limitZoom(zoom)];
        const ids = tree.range(lngX(minLng), latY(maxLat), lngX(maxLng), latY(minLat));
        const clusters = [];
        for (const id of ids) {
            const c = tree.points[id];
            clusters.push(c.numPoints ? getClusterJSON(c) : this.points[c.index]);
        }
        return clusters;
    }

    getChildren(clusterId) {
        const originId = this._getOriginId(clusterId);
        const originZoom = this._getOriginZoom(clusterId);
        const errorMsg = 'No cluster with the specified id.';

        const index = this.trees[originZoom];
        if (!index) throw new Error(errorMsg);

        const origin = index.points[originId];
        if (!origin) throw new Error(errorMsg);

        const r = this.options.radius / (this.options.extent * Math.pow(2, originZoom - 1));
        const ids = index.within(origin.x, origin.y, r);
        const children = [];
        for (const id of ids) {
            const c = index.points[id];
            if (c.parentId === clusterId) {
                children.push(c.numPoints ? getClusterJSON(c) : this.points[c.index]);
            }
        }

        if (children.length === 0) throw new Error(errorMsg);

        return children;
    }

    getLeaves(clusterId, limit, offset) {
        limit = limit || 10;
        offset = offset || 0;

        const leaves = [];
        this._appendLeaves(leaves, clusterId, limit, offset, 0);

        return leaves;
    }

    getTile(z, x, y) {
        const tree = this.trees[this._limitZoom(z)];
        const z2 = Math.pow(2, z);
        const {extent, radius} = this.options;
        const p = radius / extent;
        const top = (y - p) / z2;
        const bottom = (y + 1 + p) / z2;

        const tile = {
            features: []
        };

        this._addTileFeatures(
            tree.range((x - p) / z2, top, (x + 1 + p) / z2, bottom),
            tree.points, x, y, z2, tile);

        if (x === 0) {
            this._addTileFeatures(
                tree.range(1 - p / z2, top, 1, bottom),
                tree.points, z2, y, z2, tile);
        }
        if (x === z2 - 1) {
            this._addTileFeatures(
                tree.range(0, top, p / z2, bottom),
                tree.points, -1, y, z2, tile);
        }

        return tile.features.length ? tile : null;
    }

    getClusterExpansionZoom(clusterId) {
        let expansionZoom = this._getOriginZoom(clusterId) - 1;
        while (expansionZoom <= this.options.maxZoom) {
            const children = this.getChildren(clusterId);
            expansionZoom++;
            if (children.length !== 1) break;
            clusterId = children[0].properties.cluster_id;
        }
        return expansionZoom;
    }

    _appendLeaves(result, clusterId, limit, offset, skipped) {
        const children = this.getChildren(clusterId);

        for (const child of children) {
            const props = child.properties;

            if (props && props.cluster) {
                if (skipped + props.point_count <= offset) {
                    // skip the whole cluster
                    skipped += props.point_count;
                } else {
                    // enter the cluster
                    skipped = this._appendLeaves(result, props.cluster_id, limit, offset, skipped);
                    // exit the cluster
                }
            } else if (skipped < offset) {
                // skip a single point
                skipped++;
            } else {
                // add a single point
                result.push(child);
            }
            if (result.length === limit) break;
        }

        return skipped;
    }

    _addTileFeatures(ids, points, x, y, z2, tile) {
        for (const i of ids) {
            const c = points[i];
            const isCluster = c.numPoints;

            let tags, px, py;
            if (isCluster) {
                tags = getClusterProperties(c);
                px = c.x;
                py = c.y;
            } else {
                const p = this.points[c.index];
                tags = p.properties;
                px = lngX(p.geometry.coordinates[0]);
                py = latY(p.geometry.coordinates[1]);
            }

            const f = {
                type: 1,
                geometry: [[
                    Math.round(this.options.extent * (px * z2 - x)),
                    Math.round(this.options.extent * (py * z2 - y))
                ]],
                tags
            };

            // assign id
            let id;
            if (isCluster) {
                id = c.id;
            } else if (this.options.generateId) {
                // optionally generate id
                id = c.index;
            } else if (this.points[c.index].id) {
                // keep id if already assigned
                id = this.points[c.index].id;
            }

            if (id !== undefined) f.id = id;

            tile.features.push(f);
        }
    }

    _limitZoom(z) {
        return Math.max(this.options.minZoom, Math.min(+z, this.options.maxZoom + 1));
    }

    _cluster(points, zoom) {
        const clusters = [];
        const {radius, extent, reduce, minPoints} = this.options;
        const r = radius / (extent * Math.pow(2, zoom));

        // loop through each point
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            // if we've already visited the point at this zoom level, skip it
            if (p.zoom <= zoom) continue;
            p.zoom = zoom;

            // find all nearby points
            const tree = this.trees[zoom + 1];
            const neighborIds = tree.within(p.x, p.y, r);

            const numPointsOrigin = p.numPoints || 1;
            let numPoints = numPointsOrigin;

            // count the number of points in a potential cluster
            for (const neighborId of neighborIds) {
                const b = tree.points[neighborId];
                // filter out neighbors that are already processed
                if (b.zoom > zoom) numPoints += b.numPoints || 1;
            }

            // if there were neighbors to merge, and there are enough points to form a cluster
            if (numPoints > numPointsOrigin && numPoints >= minPoints) {
                let wx = p.x * numPointsOrigin;
                let wy = p.y * numPointsOrigin;

                let clusterProperties = reduce && numPointsOrigin > 1 ? this._map(p, true) : null;

                // encode both zoom and point index on which the cluster originated -- offset by total length of features
                const id = (i << 5) + (zoom + 1) + this.points.length;

                for (const neighborId of neighborIds) {
                    const b = tree.points[neighborId];

                    if (b.zoom <= zoom) continue;
                    b.zoom = zoom; // save the zoom (so it doesn't get processed twice)

                    const numPoints2 = b.numPoints || 1;
                    wx += b.x * numPoints2; // accumulate coordinates for calculating weighted center
                    wy += b.y * numPoints2;

                    b.parentId = id;

                    if (reduce) {
                        if (!clusterProperties) clusterProperties = this._map(p, true);
                        reduce(clusterProperties, this._map(b));
                    }
                }

                p.parentId = id;
                clusters.push(createCluster(wx / numPoints, wy / numPoints, id, numPoints, clusterProperties));

            } else { // left points as unclustered
                clusters.push(p);

                if (numPoints > 1) {
                    for (const neighborId of neighborIds) {
                        const b = tree.points[neighborId];
                        if (b.zoom <= zoom) continue;
                        b.zoom = zoom;
                        clusters.push(b);
                    }
                }
            }
        }

        return clusters;
    }

    // get index of the point from which the cluster originated
    _getOriginId(clusterId) {
        return (clusterId - this.points.length) >> 5;
    }

    // get zoom of the point from which the cluster originated
    _getOriginZoom(clusterId) {
        return (clusterId - this.points.length) % 32;
    }

    _map(point, clone) {
        if (point.numPoints) {
            return clone ? extend({}, point.properties) : point.properties;
        }
        const original = this.points[point.index].properties;
        const result = this.options.map(original);
        return clone && result === original ? extend({}, result) : result;
    }
}

function createCluster(x, y, id, numPoints, properties) {
    return {
        x: fround(x), // weighted cluster center; round for consistency with Float32Array index
        y: fround(y),
        zoom: Infinity, // the last zoom the cluster was processed at
        id, // encodes index of the first child of the cluster and its zoom level
        parentId: -1, // parent cluster id
        numPoints,
        properties
    };
}

function createPointCluster(p, id) {
    const [x, y] = p.geometry.coordinates;
    return {
        x: fround(lngX(x)), // projected point coordinates
        y: fround(latY(y)),
        zoom: Infinity, // the last zoom the point was processed at
        index: id, // index of the source feature in the original input array,
        parentId: -1 // parent cluster id
    };
}

function getClusterJSON(cluster) {
    return {
        type: 'Feature',
        id: cluster.id,
        properties: getClusterProperties(cluster),
        geometry: {
            type: 'Point',
            coordinates: [xLng(cluster.x), yLat(cluster.y)]
        }
    };
}

function getClusterProperties(cluster) {
    const count = cluster.numPoints;
    const abbrev =
        count >= 10000 ? `${Math.round(count / 1000)  }k` :
        count >= 1000 ? `${Math.round(count / 100) / 10  }k` : count;
    return extend(extend({}, cluster.properties), {
        cluster: true,
        cluster_id: cluster.id,
        point_count: count,
        point_count_abbreviated: abbrev
    });
}

// longitude/latitude to spherical mercator in [0..1] range
function lngX(lng) {
    return lng / 360 + 0.5;
}
function latY(lat) {
    const sin = Math.sin(lat * Math.PI / 180);
    const y = (0.5 - 0.25 * Math.log((1 + sin) / (1 - sin)) / Math.PI);
    return y < 0 ? 0 : y > 1 ? 1 : y;
}

// spherical mercator to longitude/latitude
function xLng(x) {
    return (x - 0.5) * 360;
}
function yLat(y) {
    const y2 = (180 - y * 360) * Math.PI / 180;
    return 360 * Math.atan(Math.exp(y2)) / Math.PI - 90;
}

function extend(dest, src) {
    for (const id in src) dest[id] = src[id];
    return dest;
}

function getX(p) {
    return p.x;
}
function getY(p) {
    return p.y;
}

function loadGeoJSONTile(params, callback) {
    const canonical = params.tileID.canonical;
    if (!this._geoJSONIndex) {
        return callback(null, null); // we couldn't load the file
    }
    const geoJSONTile = this._geoJSONIndex.getTile(canonical.z, canonical.x, canonical.y);
    if (!geoJSONTile) {
        return callback(null, null); // nothing in the given tile
    }
    const geojsonWrapper = new GeoJSONWrapper(geoJSONTile.features);
    // Encode the geojson-vt tile into binary vector tile form.  This
    // is a convenience that allows `FeatureIndex` to operate the same way
    // across `VectorTileSource` and `GeoJSONSource` data.
    let pbf = vtpbf(geojsonWrapper);
    if (pbf.byteOffset !== 0 || pbf.byteLength !== pbf.buffer.byteLength) {
        // Compatibility with node Buffer (https://github.com/mapbox/pbf/issues/35)
        pbf = new Uint8Array(pbf);
    }
    callback(null, {
        vectorTile: geojsonWrapper,
        rawData: pbf.buffer
    });
}
/**
 * The {@link WorkerSource} implementation that supports {@link GeoJSONSource}.
 * This class is designed to be easily reused to support custom source types
 * for data formats that can be parsed/converted into an in-memory GeoJSON
 * representation.  To do so, create it with
 * `new GeoJSONWorkerSource(actor, layerIndex, customLoadGeoJSONFunction)`.
 * For a full example, see [mapbox-gl-topojson](https://github.com/developmentseed/mapbox-gl-topojson).
 *
 * @private
 */
class GeoJSONWorkerSource extends VectorTileWorkerSource {
    /**
     * @param [loadGeoJSON] Optional method for custom loading/parsing of
     * GeoJSON based on parameters passed from the main-thread Source.
     * See {@link GeoJSONWorkerSource#loadGeoJSON}.
     * @private
     */
    constructor(actor, layerIndex, availableImages, loadGeoJSON) {
        super(actor, layerIndex, availableImages, loadGeoJSONTile);
        if (loadGeoJSON) {
            this.loadGeoJSON = loadGeoJSON;
        }
    }
    /**
     * Fetches (if appropriate), parses, and index geojson data into tiles. This
     * preparatory method must be called before {@link GeoJSONWorkerSource#loadTile}
     * can correctly serve up tiles.
     *
     * Defers to {@link GeoJSONWorkerSource#loadGeoJSON} for the fetching/parsing,
     * expecting `callback(error, data)` to be called with either an error or a
     * parsed GeoJSON object.
     *
     * When a `loadData` request comes in while a previous one is being processed,
     * the previous one is aborted.
     *
     * @param params
     * @param callback
     * @private
     */
    loadData(params, callback) {
        var _a;
        (_a = this._pendingRequest) === null || _a === void 0 ? void 0 : _a.cancel();
        if (this._pendingCallback) {
            // Tell the foreground the previous call has been abandoned
            this._pendingCallback(null, { abandoned: true });
        }
        const perf = (params && params.request && params.request.collectResourceTiming) ?
            new performance.RequestPerformance(params.request) : false;
        this._pendingCallback = callback;
        this._pendingRequest = this.loadGeoJSON(params, (err, data) => {
            delete this._pendingCallback;
            delete this._pendingRequest;
            if (err || !data) {
                return callback(err);
            }
            else if (typeof data !== 'object') {
                return callback(new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`));
            }
            else {
                geojsonRewind(data, true);
                try {
                    if (params.filter) {
                        const compiled = performance.createExpression(params.filter, { type: 'boolean', 'property-type': 'data-driven', overridable: false, transition: false });
                        if (compiled.result === 'error')
                            throw new Error(compiled.value.map(err => `${err.key}: ${err.message}`).join(', '));
                        const features = data.features.filter(feature => compiled.value.evaluate({ zoom: 0 }, feature));
                        data = { type: 'FeatureCollection', features };
                    }
                    this._geoJSONIndex = params.cluster ?
                        new Supercluster(getSuperclusterOptions(params)).load(data.features) :
                        geojsonvt(data, params.geojsonVtOptions);
                }
                catch (err) {
                    return callback(err);
                }
                this.loaded = {};
                const result = {};
                if (perf) {
                    const resourceTimingData = perf.finish();
                    // it's necessary to eval the result of getEntriesByName() here via parse/stringify
                    // late evaluation in the main thread causes TypeError: illegal invocation
                    if (resourceTimingData) {
                        result.resourceTiming = {};
                        result.resourceTiming[params.source] = JSON.parse(JSON.stringify(resourceTimingData));
                    }
                }
                callback(null, result);
            }
        });
    }
    /**
    * Implements {@link WorkerSource#reloadTile}.
    *
    * If the tile is loaded, uses the implementation in VectorTileWorkerSource.
    * Otherwise, such as after a setData() call, we load the tile fresh.
    *
    * @param params
    * @param params.uid The UID for this tile.
    * @private
    */
    reloadTile(params, callback) {
        const loaded = this.loaded, uid = params.uid;
        if (loaded && loaded[uid]) {
            return super.reloadTile(params, callback);
        }
        else {
            return this.loadTile(params, callback);
        }
    }
    /**
     * Fetch and parse GeoJSON according to the given params.  Calls `callback`
     * with `(err, data)`, where `data` is a parsed GeoJSON object.
     *
     * GeoJSON is loaded and parsed from `params.url` if it exists, or else
     * expected as a literal (string or object) `params.data`.
     *
     * @param params
     * @param [params.url] A URL to the remote GeoJSON data.
     * @param [params.data] Literal GeoJSON data. Must be provided if `params.url` is not.
     * @returns {Cancelable} A Cancelable object.
     * @private
     */
    loadGeoJSON(params, callback) {
        // Because of same origin issues, urls must either include an explicit
        // origin or absolute path.
        // ie: /foo/bar.json or http://example.com/bar.json
        // but not ../foo/bar.json
        if (params.request) {
            return performance.getJSON(params.request, callback);
        }
        else if (typeof params.data === 'string') {
            try {
                callback(null, JSON.parse(params.data));
            }
            catch (e) {
                callback(new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`));
            }
        }
        else {
            callback(new Error(`Input data given to '${params.source}' is not a valid GeoJSON object.`));
        }
        return { cancel: () => { } };
    }
    removeSource(params, callback) {
        if (this._pendingCallback) {
            // Don't leak callbacks
            this._pendingCallback(null, { abandoned: true });
        }
        callback();
    }
    getClusterExpansionZoom(params, callback) {
        try {
            callback(null, this._geoJSONIndex.getClusterExpansionZoom(params.clusterId));
        }
        catch (e) {
            callback(e);
        }
    }
    getClusterChildren(params, callback) {
        try {
            callback(null, this._geoJSONIndex.getChildren(params.clusterId));
        }
        catch (e) {
            callback(e);
        }
    }
    getClusterLeaves(params, callback) {
        try {
            callback(null, this._geoJSONIndex.getLeaves(params.clusterId, params.limit, params.offset));
        }
        catch (e) {
            callback(e);
        }
    }
}
function getSuperclusterOptions({ superclusterOptions, clusterProperties }) {
    if (!clusterProperties || !superclusterOptions)
        return superclusterOptions;
    const mapExpressions = {};
    const reduceExpressions = {};
    const globals = { accumulated: null, zoom: 0 };
    const feature = { properties: null };
    const propertyNames = Object.keys(clusterProperties);
    for (const key of propertyNames) {
        const [operator, mapExpression] = clusterProperties[key];
        const mapExpressionParsed = performance.createExpression(mapExpression);
        const reduceExpressionParsed = performance.createExpression(typeof operator === 'string' ? [operator, ['accumulated'], ['get', key]] : operator);
        performance.assert(mapExpressionParsed.result === 'success');
        performance.assert(reduceExpressionParsed.result === 'success');
        mapExpressions[key] = mapExpressionParsed.value;
        reduceExpressions[key] = reduceExpressionParsed.value;
    }
    superclusterOptions.map = (pointProperties) => {
        feature.properties = pointProperties;
        const properties = {};
        for (const key of propertyNames) {
            properties[key] = mapExpressions[key].evaluate(globals, feature);
        }
        return properties;
    };
    superclusterOptions.reduce = (accumulated, clusterProperties) => {
        feature.properties = clusterProperties;
        for (const key of propertyNames) {
            globals.accumulated = accumulated[key];
            accumulated[key] = reduceExpressions[key].evaluate(globals, feature);
        }
    };
    return superclusterOptions;
}

/**
 * @private
 */
class Worker {
    constructor(self) {
        this.self = self;
        this.actor = new performance.Actor(self, this);
        this.layerIndexes = {};
        this.availableImages = {};
        this.workerSourceTypes = {
            vector: VectorTileWorkerSource,
            temporalgrid: TemporalGridTileWorkerSource,
            geojson: GeoJSONWorkerSource
        };
        // [mapId][sourceType][sourceName] => worker source instance
        this.workerSources = {};
        this.demWorkerSources = {};
        this.self.registerWorkerSource = (name, WorkerSource) => {
            if (this.workerSourceTypes[name]) {
                throw new Error(`Worker source with name "${name}" already registered.`);
            }
            this.workerSourceTypes[name] = WorkerSource;
        };
        // This is invoked by the RTL text plugin when the download via the `importScripts` call has finished, and the code has been parsed.
        this.self.registerRTLTextPlugin = (rtlTextPlugin) => {
            if (performance.plugin.isParsed()) {
                throw new Error('RTL text plugin already registered.');
            }
            performance.plugin['applyArabicShaping'] = rtlTextPlugin.applyArabicShaping;
            performance.plugin['processBidirectionalText'] = rtlTextPlugin.processBidirectionalText;
            performance.plugin['processStyledBidirectionalText'] = rtlTextPlugin.processStyledBidirectionalText;
        };
    }
    setReferrer(mapID, referrer) {
        this.referrer = referrer;
    }
    setImages(mapId, images, callback) {
        this.availableImages[mapId] = images;
        for (const workerSource in this.workerSources[mapId]) {
            const ws = this.workerSources[mapId][workerSource];
            for (const source in ws) {
                ws[source].availableImages = images;
            }
        }
        callback();
    }
    setLayers(mapId, layers, callback) {
        this.getLayerIndex(mapId).replace(layers);
        callback();
    }
    updateLayers(mapId, params, callback) {
        this.getLayerIndex(mapId).update(params.layers, params.removedIds);
        callback();
    }
    loadTile(mapId, params, callback) {
        performance.assert(params.type);
        this.getWorkerSource(mapId, params.type, params.source).loadTile(params, callback);
    }
    loadDEMTile(mapId, params, callback) {
        this.getDEMWorkerSource(mapId, params.source).loadTile(params, callback);
    }
    reloadTile(mapId, params, callback) {
        performance.assert(params.type);
        this.getWorkerSource(mapId, params.type, params.source).reloadTile(params, callback);
    }
    abortTile(mapId, params, callback) {
        performance.assert(params.type);
        this.getWorkerSource(mapId, params.type, params.source).abortTile(params, callback);
    }
    removeTile(mapId, params, callback) {
        performance.assert(params.type);
        this.getWorkerSource(mapId, params.type, params.source).removeTile(params, callback);
    }
    removeDEMTile(mapId, params) {
        this.getDEMWorkerSource(mapId, params.source).removeTile(params);
    }
    removeSource(mapId, params, callback) {
        performance.assert(params.type);
        performance.assert(params.source);
        if (!this.workerSources[mapId] ||
            !this.workerSources[mapId][params.type] ||
            !this.workerSources[mapId][params.type][params.source]) {
            return;
        }
        const worker = this.workerSources[mapId][params.type][params.source];
        delete this.workerSources[mapId][params.type][params.source];
        if (worker.removeSource !== undefined) {
            worker.removeSource(params, callback);
        }
        else {
            callback();
        }
    }
    /**
     * Load a {@link WorkerSource} script at params.url.  The script is run
     * (using importScripts) with `registerWorkerSource` in scope, which is a
     * function taking `(name, workerSourceObject)`.
     *  @private
     */
    loadWorkerSource(map, params, callback) {
        try {
            this.self.importScripts(params.url);
            callback();
        }
        catch (e) {
            callback(e.toString());
        }
    }
    syncRTLPluginState(map, state, callback) {
        try {
            performance.plugin.setState(state);
            const pluginURL = performance.plugin.getPluginURL();
            if (performance.plugin.isLoaded() &&
                !performance.plugin.isParsed() &&
                pluginURL != null // Not possible when `isLoaded` is true, but keeps flow happy
            ) {
                this.self.importScripts(pluginURL);
                const complete = performance.plugin.isParsed();
                const error = complete ? undefined : new Error(`RTL Text Plugin failed to import scripts from ${pluginURL}`);
                callback(error, complete);
            }
        }
        catch (e) {
            callback(e.toString());
        }
    }
    getAvailableImages(mapId) {
        let availableImages = this.availableImages[mapId];
        if (!availableImages) {
            availableImages = [];
        }
        return availableImages;
    }
    getLayerIndex(mapId) {
        let layerIndexes = this.layerIndexes[mapId];
        if (!layerIndexes) {
            layerIndexes = this.layerIndexes[mapId] = new StyleLayerIndex();
        }
        return layerIndexes;
    }
    getWorkerSource(mapId, type, source) {
        if (!this.workerSources[mapId])
            this.workerSources[mapId] = {};
        if (!this.workerSources[mapId][type])
            this.workerSources[mapId][type] = {};
        if (!this.workerSources[mapId][type][source]) {
            // use a wrapped actor so that we can attach a target mapId param
            // to any messages invoked by the WorkerSource
            const actor = {
                send: (type, data, callback) => {
                    this.actor.send(type, data, callback, mapId);
                }
            };
            this.workerSources[mapId][type][source] = new this.workerSourceTypes[type](actor, this.getLayerIndex(mapId), this.getAvailableImages(mapId));
        }
        return this.workerSources[mapId][type][source];
    }
    getDEMWorkerSource(mapId, source) {
        if (!this.demWorkerSources[mapId])
            this.demWorkerSources[mapId] = {};
        if (!this.demWorkerSources[mapId][source]) {
            this.demWorkerSources[mapId][source] = new RasterDEMTileWorkerSource();
        }
        return this.demWorkerSources[mapId][source];
    }
    enforceCacheSizeLimit(mapId, limit) {
        performance.enforceCacheSizeLimit(limit);
    }
}
/* global self, WorkerGlobalScope */
if (typeof WorkerGlobalScope !== 'undefined' &&
    typeof self !== 'undefined' &&
    self instanceof WorkerGlobalScope) {
    self.worker = new Worker(self);
}

return Worker;

}));
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvc3R5bGUtc3BlYy9ncm91cF9ieV9sYXlvdXQudHMiLCIuLi8uLi8uLi9zcmMvc3R5bGUvc3R5bGVfbGF5ZXJfaW5kZXgudHMiLCIuLi8uLi8uLi9zcmMvcmVuZGVyL2dseXBoX2F0bGFzLnRzIiwiLi4vLi4vLi4vc3JjL3NvdXJjZS93b3JrZXJfdGlsZS50cyIsIi4uLy4uLy4uL3NyYy9zb3VyY2UvdmVjdG9yX3RpbGVfd29ya2VyX3NvdXJjZS50cyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy92dC1wYmYvbGliL2dlb2pzb25fd3JhcHBlci5qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy92dC1wYmYvaW5kZXguanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvZ2VvanNvbi12dC9zcmMvc2ltcGxpZnkuanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvZ2VvanNvbi12dC9zcmMvZmVhdHVyZS5qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy9nZW9qc29uLXZ0L3NyYy9jb252ZXJ0LmpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL2dlb2pzb24tdnQvc3JjL2NsaXAuanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvZ2VvanNvbi12dC9zcmMvd3JhcC5qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy9nZW9qc29uLXZ0L3NyYy90cmFuc2Zvcm0uanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvZ2VvanNvbi12dC9zcmMvdGlsZS5qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy9nZW9qc29uLXZ0L3NyYy9pbmRleC5qcyIsIi4uLy4uLy4uL3NyYy9zb3VyY2UvZ2VvanNvbl93cmFwcGVyLnRzIiwiLi4vLi4vLi4vc3JjL3NvdXJjZS9tdWx0aV9zb3VyY2VfZ2VvanNvbl93cmFwcGVyLnRzIiwiLi4vLi4vLi4vLi4vZnJvbnRlbmQvbGlicy9mb3Vyd2luZ3MtYWdncmVnYXRlL2Rpc3QvaW5kZXguanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvQG1hcGJveC90aWxlYmVsdC9pbmRleC5qcyIsIi4uLy4uLy4uL3NyYy9zb3VyY2UvdGVtcG9yYWxncmlkX3RpbGVfd29ya2VyX3NvdXJjZS50cyIsIi4uLy4uLy4uL3NyYy9zb3VyY2UvcmFzdGVyX2RlbV90aWxlX3dvcmtlcl9zb3VyY2UudHMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMvQG1hcGJveC9nZW9qc29uLXJld2luZC9pbmRleC5qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy9rZGJ1c2gvc3JjL3NvcnQuanMiLCIuLi8uLi8uLi9ub2RlX21vZHVsZXMva2RidXNoL3NyYy9yYW5nZS5qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy9rZGJ1c2gvc3JjL3dpdGhpbi5qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy9rZGJ1c2gvc3JjL2luZGV4LmpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3N1cGVyY2x1c3Rlci9pbmRleC5qcyIsIi4uLy4uLy4uL3NyYy9zb3VyY2UvZ2VvanNvbl93b3JrZXJfc291cmNlLnRzIiwiLi4vLi4vLi4vc3JjL3NvdXJjZS93b3JrZXIudHMiXSwic291cmNlc0NvbnRlbnQiOltudWxsLG51bGwsbnVsbCxudWxsLG51bGwsIid1c2Ugc3RyaWN0J1xuXG52YXIgUG9pbnQgPSByZXF1aXJlKCdAbWFwYm94L3BvaW50LWdlb21ldHJ5JylcbnZhciBWZWN0b3JUaWxlRmVhdHVyZSA9IHJlcXVpcmUoJ0BtYXBib3gvdmVjdG9yLXRpbGUnKS5WZWN0b3JUaWxlRmVhdHVyZVxuXG5tb2R1bGUuZXhwb3J0cyA9IEdlb0pTT05XcmFwcGVyXG5cbi8vIGNvbmZvcm0gdG8gdmVjdG9ydGlsZSBhcGlcbmZ1bmN0aW9uIEdlb0pTT05XcmFwcGVyIChmZWF0dXJlcywgb3B0aW9ucykge1xuICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zIHx8IHt9XG4gIHRoaXMuZmVhdHVyZXMgPSBmZWF0dXJlc1xuICB0aGlzLmxlbmd0aCA9IGZlYXR1cmVzLmxlbmd0aFxufVxuXG5HZW9KU09OV3JhcHBlci5wcm90b3R5cGUuZmVhdHVyZSA9IGZ1bmN0aW9uIChpKSB7XG4gIHJldHVybiBuZXcgRmVhdHVyZVdyYXBwZXIodGhpcy5mZWF0dXJlc1tpXSwgdGhpcy5vcHRpb25zLmV4dGVudClcbn1cblxuZnVuY3Rpb24gRmVhdHVyZVdyYXBwZXIgKGZlYXR1cmUsIGV4dGVudCkge1xuICB0aGlzLmlkID0gdHlwZW9mIGZlYXR1cmUuaWQgPT09ICdudW1iZXInID8gZmVhdHVyZS5pZCA6IHVuZGVmaW5lZFxuICB0aGlzLnR5cGUgPSBmZWF0dXJlLnR5cGVcbiAgdGhpcy5yYXdHZW9tZXRyeSA9IGZlYXR1cmUudHlwZSA9PT0gMSA/IFtmZWF0dXJlLmdlb21ldHJ5XSA6IGZlYXR1cmUuZ2VvbWV0cnlcbiAgdGhpcy5wcm9wZXJ0aWVzID0gZmVhdHVyZS50YWdzXG4gIHRoaXMuZXh0ZW50ID0gZXh0ZW50IHx8IDQwOTZcbn1cblxuRmVhdHVyZVdyYXBwZXIucHJvdG90eXBlLmxvYWRHZW9tZXRyeSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHJpbmdzID0gdGhpcy5yYXdHZW9tZXRyeVxuICB0aGlzLmdlb21ldHJ5ID0gW11cblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHJpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIHJpbmcgPSByaW5nc1tpXVxuICAgIHZhciBuZXdSaW5nID0gW11cbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IHJpbmcubGVuZ3RoOyBqKyspIHtcbiAgICAgIG5ld1JpbmcucHVzaChuZXcgUG9pbnQocmluZ1tqXVswXSwgcmluZ1tqXVsxXSkpXG4gICAgfVxuICAgIHRoaXMuZ2VvbWV0cnkucHVzaChuZXdSaW5nKVxuICB9XG4gIHJldHVybiB0aGlzLmdlb21ldHJ5XG59XG5cbkZlYXR1cmVXcmFwcGVyLnByb3RvdHlwZS5iYm94ID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuZ2VvbWV0cnkpIHRoaXMubG9hZEdlb21ldHJ5KClcblxuICB2YXIgcmluZ3MgPSB0aGlzLmdlb21ldHJ5XG4gIHZhciB4MSA9IEluZmluaXR5XG4gIHZhciB4MiA9IC1JbmZpbml0eVxuICB2YXIgeTEgPSBJbmZpbml0eVxuICB2YXIgeTIgPSAtSW5maW5pdHlcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHJpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIHJpbmcgPSByaW5nc1tpXVxuXG4gICAgZm9yICh2YXIgaiA9IDA7IGogPCByaW5nLmxlbmd0aDsgaisrKSB7XG4gICAgICB2YXIgY29vcmQgPSByaW5nW2pdXG5cbiAgICAgIHgxID0gTWF0aC5taW4oeDEsIGNvb3JkLngpXG4gICAgICB4MiA9IE1hdGgubWF4KHgyLCBjb29yZC54KVxuICAgICAgeTEgPSBNYXRoLm1pbih5MSwgY29vcmQueSlcbiAgICAgIHkyID0gTWF0aC5tYXgoeTIsIGNvb3JkLnkpXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIFt4MSwgeTEsIHgyLCB5Ml1cbn1cblxuRmVhdHVyZVdyYXBwZXIucHJvdG90eXBlLnRvR2VvSlNPTiA9IFZlY3RvclRpbGVGZWF0dXJlLnByb3RvdHlwZS50b0dlb0pTT05cbiIsInZhciBQYmYgPSByZXF1aXJlKCdwYmYnKVxudmFyIEdlb0pTT05XcmFwcGVyID0gcmVxdWlyZSgnLi9saWIvZ2VvanNvbl93cmFwcGVyJylcblxubW9kdWxlLmV4cG9ydHMgPSBmcm9tVmVjdG9yVGlsZUpzXG5tb2R1bGUuZXhwb3J0cy5mcm9tVmVjdG9yVGlsZUpzID0gZnJvbVZlY3RvclRpbGVKc1xubW9kdWxlLmV4cG9ydHMuZnJvbUdlb2pzb25WdCA9IGZyb21HZW9qc29uVnRcbm1vZHVsZS5leHBvcnRzLkdlb0pTT05XcmFwcGVyID0gR2VvSlNPTldyYXBwZXJcblxuLyoqXG4gKiBTZXJpYWxpemUgYSB2ZWN0b3ItdGlsZS1qcy1jcmVhdGVkIHRpbGUgdG8gcGJmXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IHRpbGVcbiAqIEByZXR1cm4ge0J1ZmZlcn0gdW5jb21wcmVzc2VkLCBwYmYtc2VyaWFsaXplZCB0aWxlIGRhdGFcbiAqL1xuZnVuY3Rpb24gZnJvbVZlY3RvclRpbGVKcyAodGlsZSkge1xuICB2YXIgb3V0ID0gbmV3IFBiZigpXG4gIHdyaXRlVGlsZSh0aWxlLCBvdXQpXG4gIHJldHVybiBvdXQuZmluaXNoKClcbn1cblxuLyoqXG4gKiBTZXJpYWxpemVkIGEgZ2VvanNvbi12dC1jcmVhdGVkIHRpbGUgdG8gcGJmLlxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBsYXllcnMgLSBBbiBvYmplY3QgbWFwcGluZyBsYXllciBuYW1lcyB0byBnZW9qc29uLXZ0LWNyZWF0ZWQgdmVjdG9yIHRpbGUgb2JqZWN0c1xuICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXSAtIEFuIG9iamVjdCBzcGVjaWZ5aW5nIHRoZSB2ZWN0b3ItdGlsZSBzcGVjaWZpY2F0aW9uIHZlcnNpb24gYW5kIGV4dGVudCB0aGF0IHdlcmUgdXNlZCB0byBjcmVhdGUgYGxheWVyc2AuXG4gKiBAcGFyYW0ge051bWJlcn0gW29wdGlvbnMudmVyc2lvbj0xXSAtIFZlcnNpb24gb2YgdmVjdG9yLXRpbGUgc3BlYyB1c2VkXG4gKiBAcGFyYW0ge051bWJlcn0gW29wdGlvbnMuZXh0ZW50PTQwOTZdIC0gRXh0ZW50IG9mIHRoZSB2ZWN0b3IgdGlsZVxuICogQHJldHVybiB7QnVmZmVyfSB1bmNvbXByZXNzZWQsIHBiZi1zZXJpYWxpemVkIHRpbGUgZGF0YVxuICovXG5mdW5jdGlvbiBmcm9tR2VvanNvblZ0IChsYXllcnMsIG9wdGlvbnMpIHtcbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge31cbiAgdmFyIGwgPSB7fVxuICBmb3IgKHZhciBrIGluIGxheWVycykge1xuICAgIGxba10gPSBuZXcgR2VvSlNPTldyYXBwZXIobGF5ZXJzW2tdLmZlYXR1cmVzLCBvcHRpb25zKVxuICAgIGxba10ubmFtZSA9IGtcbiAgICBsW2tdLnZlcnNpb24gPSBvcHRpb25zLnZlcnNpb25cbiAgICBsW2tdLmV4dGVudCA9IG9wdGlvbnMuZXh0ZW50XG4gIH1cbiAgcmV0dXJuIGZyb21WZWN0b3JUaWxlSnMoeyBsYXllcnM6IGwgfSlcbn1cblxuZnVuY3Rpb24gd3JpdGVUaWxlICh0aWxlLCBwYmYpIHtcbiAgZm9yICh2YXIga2V5IGluIHRpbGUubGF5ZXJzKSB7XG4gICAgcGJmLndyaXRlTWVzc2FnZSgzLCB3cml0ZUxheWVyLCB0aWxlLmxheWVyc1trZXldKVxuICB9XG59XG5cbmZ1bmN0aW9uIHdyaXRlTGF5ZXIgKGxheWVyLCBwYmYpIHtcbiAgcGJmLndyaXRlVmFyaW50RmllbGQoMTUsIGxheWVyLnZlcnNpb24gfHwgMSlcbiAgcGJmLndyaXRlU3RyaW5nRmllbGQoMSwgbGF5ZXIubmFtZSB8fCAnJylcbiAgcGJmLndyaXRlVmFyaW50RmllbGQoNSwgbGF5ZXIuZXh0ZW50IHx8IDQwOTYpXG5cbiAgdmFyIGlcbiAgdmFyIGNvbnRleHQgPSB7XG4gICAga2V5czogW10sXG4gICAgdmFsdWVzOiBbXSxcbiAgICBrZXljYWNoZToge30sXG4gICAgdmFsdWVjYWNoZToge31cbiAgfVxuXG4gIGZvciAoaSA9IDA7IGkgPCBsYXllci5sZW5ndGg7IGkrKykge1xuICAgIGNvbnRleHQuZmVhdHVyZSA9IGxheWVyLmZlYXR1cmUoaSlcbiAgICBwYmYud3JpdGVNZXNzYWdlKDIsIHdyaXRlRmVhdHVyZSwgY29udGV4dClcbiAgfVxuXG4gIHZhciBrZXlzID0gY29udGV4dC5rZXlzXG4gIGZvciAoaSA9IDA7IGkgPCBrZXlzLmxlbmd0aDsgaSsrKSB7XG4gICAgcGJmLndyaXRlU3RyaW5nRmllbGQoMywga2V5c1tpXSlcbiAgfVxuXG4gIHZhciB2YWx1ZXMgPSBjb250ZXh0LnZhbHVlc1xuICBmb3IgKGkgPSAwOyBpIDwgdmFsdWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgcGJmLndyaXRlTWVzc2FnZSg0LCB3cml0ZVZhbHVlLCB2YWx1ZXNbaV0pXG4gIH1cbn1cblxuZnVuY3Rpb24gd3JpdGVGZWF0dXJlIChjb250ZXh0LCBwYmYpIHtcbiAgdmFyIGZlYXR1cmUgPSBjb250ZXh0LmZlYXR1cmVcblxuICBpZiAoZmVhdHVyZS5pZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcGJmLndyaXRlVmFyaW50RmllbGQoMSwgZmVhdHVyZS5pZClcbiAgfVxuXG4gIHBiZi53cml0ZU1lc3NhZ2UoMiwgd3JpdGVQcm9wZXJ0aWVzLCBjb250ZXh0KVxuICBwYmYud3JpdGVWYXJpbnRGaWVsZCgzLCBmZWF0dXJlLnR5cGUpXG4gIHBiZi53cml0ZU1lc3NhZ2UoNCwgd3JpdGVHZW9tZXRyeSwgZmVhdHVyZSlcbn1cblxuZnVuY3Rpb24gd3JpdGVQcm9wZXJ0aWVzIChjb250ZXh0LCBwYmYpIHtcbiAgdmFyIGZlYXR1cmUgPSBjb250ZXh0LmZlYXR1cmVcbiAgdmFyIGtleXMgPSBjb250ZXh0LmtleXNcbiAgdmFyIHZhbHVlcyA9IGNvbnRleHQudmFsdWVzXG4gIHZhciBrZXljYWNoZSA9IGNvbnRleHQua2V5Y2FjaGVcbiAgdmFyIHZhbHVlY2FjaGUgPSBjb250ZXh0LnZhbHVlY2FjaGVcblxuICBmb3IgKHZhciBrZXkgaW4gZmVhdHVyZS5wcm9wZXJ0aWVzKSB7XG4gICAgdmFyIHZhbHVlID0gZmVhdHVyZS5wcm9wZXJ0aWVzW2tleV1cblxuICAgIHZhciBrZXlJbmRleCA9IGtleWNhY2hlW2tleV1cbiAgICBpZiAodmFsdWUgPT09IG51bGwpIGNvbnRpbnVlIC8vIGRvbid0IGVuY29kZSBudWxsIHZhbHVlIHByb3BlcnRpZXNcblxuICAgIGlmICh0eXBlb2Yga2V5SW5kZXggPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICBrZXlzLnB1c2goa2V5KVxuICAgICAga2V5SW5kZXggPSBrZXlzLmxlbmd0aCAtIDFcbiAgICAgIGtleWNhY2hlW2tleV0gPSBrZXlJbmRleFxuICAgIH1cbiAgICBwYmYud3JpdGVWYXJpbnQoa2V5SW5kZXgpXG5cbiAgICB2YXIgdHlwZSA9IHR5cGVvZiB2YWx1ZVxuICAgIGlmICh0eXBlICE9PSAnc3RyaW5nJyAmJiB0eXBlICE9PSAnYm9vbGVhbicgJiYgdHlwZSAhPT0gJ251bWJlcicpIHtcbiAgICAgIHZhbHVlID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpXG4gICAgfVxuICAgIHZhciB2YWx1ZUtleSA9IHR5cGUgKyAnOicgKyB2YWx1ZVxuICAgIHZhciB2YWx1ZUluZGV4ID0gdmFsdWVjYWNoZVt2YWx1ZUtleV1cbiAgICBpZiAodHlwZW9mIHZhbHVlSW5kZXggPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICB2YWx1ZXMucHVzaCh2YWx1ZSlcbiAgICAgIHZhbHVlSW5kZXggPSB2YWx1ZXMubGVuZ3RoIC0gMVxuICAgICAgdmFsdWVjYWNoZVt2YWx1ZUtleV0gPSB2YWx1ZUluZGV4XG4gICAgfVxuICAgIHBiZi53cml0ZVZhcmludCh2YWx1ZUluZGV4KVxuICB9XG59XG5cbmZ1bmN0aW9uIGNvbW1hbmQgKGNtZCwgbGVuZ3RoKSB7XG4gIHJldHVybiAobGVuZ3RoIDw8IDMpICsgKGNtZCAmIDB4Nylcbn1cblxuZnVuY3Rpb24gemlnemFnIChudW0pIHtcbiAgcmV0dXJuIChudW0gPDwgMSkgXiAobnVtID4+IDMxKVxufVxuXG5mdW5jdGlvbiB3cml0ZUdlb21ldHJ5IChmZWF0dXJlLCBwYmYpIHtcbiAgdmFyIGdlb21ldHJ5ID0gZmVhdHVyZS5sb2FkR2VvbWV0cnkoKVxuICB2YXIgdHlwZSA9IGZlYXR1cmUudHlwZVxuICB2YXIgeCA9IDBcbiAgdmFyIHkgPSAwXG4gIHZhciByaW5ncyA9IGdlb21ldHJ5Lmxlbmd0aFxuICBmb3IgKHZhciByID0gMDsgciA8IHJpbmdzOyByKyspIHtcbiAgICB2YXIgcmluZyA9IGdlb21ldHJ5W3JdXG4gICAgdmFyIGNvdW50ID0gMVxuICAgIGlmICh0eXBlID09PSAxKSB7XG4gICAgICBjb3VudCA9IHJpbmcubGVuZ3RoXG4gICAgfVxuICAgIHBiZi53cml0ZVZhcmludChjb21tYW5kKDEsIGNvdW50KSkgLy8gbW92ZXRvXG4gICAgLy8gZG8gbm90IHdyaXRlIHBvbHlnb24gY2xvc2luZyBwYXRoIGFzIGxpbmV0b1xuICAgIHZhciBsaW5lQ291bnQgPSB0eXBlID09PSAzID8gcmluZy5sZW5ndGggLSAxIDogcmluZy5sZW5ndGhcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxpbmVDb3VudDsgaSsrKSB7XG4gICAgICBpZiAoaSA9PT0gMSAmJiB0eXBlICE9PSAxKSB7XG4gICAgICAgIHBiZi53cml0ZVZhcmludChjb21tYW5kKDIsIGxpbmVDb3VudCAtIDEpKSAvLyBsaW5ldG9cbiAgICAgIH1cbiAgICAgIHZhciBkeCA9IHJpbmdbaV0ueCAtIHhcbiAgICAgIHZhciBkeSA9IHJpbmdbaV0ueSAtIHlcbiAgICAgIHBiZi53cml0ZVZhcmludCh6aWd6YWcoZHgpKVxuICAgICAgcGJmLndyaXRlVmFyaW50KHppZ3phZyhkeSkpXG4gICAgICB4ICs9IGR4XG4gICAgICB5ICs9IGR5XG4gICAgfVxuICAgIGlmICh0eXBlID09PSAzKSB7XG4gICAgICBwYmYud3JpdGVWYXJpbnQoY29tbWFuZCg3LCAxKSkgLy8gY2xvc2VwYXRoXG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHdyaXRlVmFsdWUgKHZhbHVlLCBwYmYpIHtcbiAgdmFyIHR5cGUgPSB0eXBlb2YgdmFsdWVcbiAgaWYgKHR5cGUgPT09ICdzdHJpbmcnKSB7XG4gICAgcGJmLndyaXRlU3RyaW5nRmllbGQoMSwgdmFsdWUpXG4gIH0gZWxzZSBpZiAodHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgcGJmLndyaXRlQm9vbGVhbkZpZWxkKDcsIHZhbHVlKVxuICB9IGVsc2UgaWYgKHR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgaWYgKHZhbHVlICUgMSAhPT0gMCkge1xuICAgICAgcGJmLndyaXRlRG91YmxlRmllbGQoMywgdmFsdWUpXG4gICAgfSBlbHNlIGlmICh2YWx1ZSA8IDApIHtcbiAgICAgIHBiZi53cml0ZVNWYXJpbnRGaWVsZCg2LCB2YWx1ZSlcbiAgICB9IGVsc2Uge1xuICAgICAgcGJmLndyaXRlVmFyaW50RmllbGQoNSwgdmFsdWUpXG4gICAgfVxuICB9XG59XG4iLCJcbi8vIGNhbGN1bGF0ZSBzaW1wbGlmaWNhdGlvbiBkYXRhIHVzaW5nIG9wdGltaXplZCBEb3VnbGFzLVBldWNrZXIgYWxnb3JpdGhtXG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIHNpbXBsaWZ5KGNvb3JkcywgZmlyc3QsIGxhc3QsIHNxVG9sZXJhbmNlKSB7XG4gICAgdmFyIG1heFNxRGlzdCA9IHNxVG9sZXJhbmNlO1xuICAgIHZhciBtaWQgPSAobGFzdCAtIGZpcnN0KSA+PiAxO1xuICAgIHZhciBtaW5Qb3NUb01pZCA9IGxhc3QgLSBmaXJzdDtcbiAgICB2YXIgaW5kZXg7XG5cbiAgICB2YXIgYXggPSBjb29yZHNbZmlyc3RdO1xuICAgIHZhciBheSA9IGNvb3Jkc1tmaXJzdCArIDFdO1xuICAgIHZhciBieCA9IGNvb3Jkc1tsYXN0XTtcbiAgICB2YXIgYnkgPSBjb29yZHNbbGFzdCArIDFdO1xuXG4gICAgZm9yICh2YXIgaSA9IGZpcnN0ICsgMzsgaSA8IGxhc3Q7IGkgKz0gMykge1xuICAgICAgICB2YXIgZCA9IGdldFNxU2VnRGlzdChjb29yZHNbaV0sIGNvb3Jkc1tpICsgMV0sIGF4LCBheSwgYngsIGJ5KTtcblxuICAgICAgICBpZiAoZCA+IG1heFNxRGlzdCkge1xuICAgICAgICAgICAgaW5kZXggPSBpO1xuICAgICAgICAgICAgbWF4U3FEaXN0ID0gZDtcblxuICAgICAgICB9IGVsc2UgaWYgKGQgPT09IG1heFNxRGlzdCkge1xuICAgICAgICAgICAgLy8gYSB3b3JrYXJvdW5kIHRvIGVuc3VyZSB3ZSBjaG9vc2UgYSBwaXZvdCBjbG9zZSB0byB0aGUgbWlkZGxlIG9mIHRoZSBsaXN0LFxuICAgICAgICAgICAgLy8gcmVkdWNpbmcgcmVjdXJzaW9uIGRlcHRoLCBmb3IgY2VydGFpbiBkZWdlbmVyYXRlIGlucHV0c1xuICAgICAgICAgICAgLy8gaHR0cHM6Ly9naXRodWIuY29tL21hcGJveC9nZW9qc29uLXZ0L2lzc3Vlcy8xMDRcbiAgICAgICAgICAgIHZhciBwb3NUb01pZCA9IE1hdGguYWJzKGkgLSBtaWQpO1xuICAgICAgICAgICAgaWYgKHBvc1RvTWlkIDwgbWluUG9zVG9NaWQpIHtcbiAgICAgICAgICAgICAgICBpbmRleCA9IGk7XG4gICAgICAgICAgICAgICAgbWluUG9zVG9NaWQgPSBwb3NUb01pZDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIGlmIChtYXhTcURpc3QgPiBzcVRvbGVyYW5jZSkge1xuICAgICAgICBpZiAoaW5kZXggLSBmaXJzdCA+IDMpIHNpbXBsaWZ5KGNvb3JkcywgZmlyc3QsIGluZGV4LCBzcVRvbGVyYW5jZSk7XG4gICAgICAgIGNvb3Jkc1tpbmRleCArIDJdID0gbWF4U3FEaXN0O1xuICAgICAgICBpZiAobGFzdCAtIGluZGV4ID4gMykgc2ltcGxpZnkoY29vcmRzLCBpbmRleCwgbGFzdCwgc3FUb2xlcmFuY2UpO1xuICAgIH1cbn1cblxuLy8gc3F1YXJlIGRpc3RhbmNlIGZyb20gYSBwb2ludCB0byBhIHNlZ21lbnRcbmZ1bmN0aW9uIGdldFNxU2VnRGlzdChweCwgcHksIHgsIHksIGJ4LCBieSkge1xuXG4gICAgdmFyIGR4ID0gYnggLSB4O1xuICAgIHZhciBkeSA9IGJ5IC0geTtcblxuICAgIGlmIChkeCAhPT0gMCB8fCBkeSAhPT0gMCkge1xuXG4gICAgICAgIHZhciB0ID0gKChweCAtIHgpICogZHggKyAocHkgLSB5KSAqIGR5KSAvIChkeCAqIGR4ICsgZHkgKiBkeSk7XG5cbiAgICAgICAgaWYgKHQgPiAxKSB7XG4gICAgICAgICAgICB4ID0gYng7XG4gICAgICAgICAgICB5ID0gYnk7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ID4gMCkge1xuICAgICAgICAgICAgeCArPSBkeCAqIHQ7XG4gICAgICAgICAgICB5ICs9IGR5ICogdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGR4ID0gcHggLSB4O1xuICAgIGR5ID0gcHkgLSB5O1xuXG4gICAgcmV0dXJuIGR4ICogZHggKyBkeSAqIGR5O1xufVxuIiwiXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiBjcmVhdGVGZWF0dXJlKGlkLCB0eXBlLCBnZW9tLCB0YWdzKSB7XG4gICAgdmFyIGZlYXR1cmUgPSB7XG4gICAgICAgIGlkOiB0eXBlb2YgaWQgPT09ICd1bmRlZmluZWQnID8gbnVsbCA6IGlkLFxuICAgICAgICB0eXBlOiB0eXBlLFxuICAgICAgICBnZW9tZXRyeTogZ2VvbSxcbiAgICAgICAgdGFnczogdGFncyxcbiAgICAgICAgbWluWDogSW5maW5pdHksXG4gICAgICAgIG1pblk6IEluZmluaXR5LFxuICAgICAgICBtYXhYOiAtSW5maW5pdHksXG4gICAgICAgIG1heFk6IC1JbmZpbml0eVxuICAgIH07XG4gICAgY2FsY0JCb3goZmVhdHVyZSk7XG4gICAgcmV0dXJuIGZlYXR1cmU7XG59XG5cbmZ1bmN0aW9uIGNhbGNCQm94KGZlYXR1cmUpIHtcbiAgICB2YXIgZ2VvbSA9IGZlYXR1cmUuZ2VvbWV0cnk7XG4gICAgdmFyIHR5cGUgPSBmZWF0dXJlLnR5cGU7XG5cbiAgICBpZiAodHlwZSA9PT0gJ1BvaW50JyB8fCB0eXBlID09PSAnTXVsdGlQb2ludCcgfHwgdHlwZSA9PT0gJ0xpbmVTdHJpbmcnKSB7XG4gICAgICAgIGNhbGNMaW5lQkJveChmZWF0dXJlLCBnZW9tKTtcblxuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ1BvbHlnb24nIHx8IHR5cGUgPT09ICdNdWx0aUxpbmVTdHJpbmcnKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZ2VvbS5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgY2FsY0xpbmVCQm94KGZlYXR1cmUsIGdlb21baV0pO1xuICAgICAgICB9XG5cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdNdWx0aVBvbHlnb24nKSB7XG4gICAgICAgIGZvciAoaSA9IDA7IGkgPCBnZW9tLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IGdlb21baV0ubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICAgICAgICBjYWxjTGluZUJCb3goZmVhdHVyZSwgZ2VvbVtpXVtqXSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG5cbmZ1bmN0aW9uIGNhbGNMaW5lQkJveChmZWF0dXJlLCBnZW9tKSB7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBnZW9tLmxlbmd0aDsgaSArPSAzKSB7XG4gICAgICAgIGZlYXR1cmUubWluWCA9IE1hdGgubWluKGZlYXR1cmUubWluWCwgZ2VvbVtpXSk7XG4gICAgICAgIGZlYXR1cmUubWluWSA9IE1hdGgubWluKGZlYXR1cmUubWluWSwgZ2VvbVtpICsgMV0pO1xuICAgICAgICBmZWF0dXJlLm1heFggPSBNYXRoLm1heChmZWF0dXJlLm1heFgsIGdlb21baV0pO1xuICAgICAgICBmZWF0dXJlLm1heFkgPSBNYXRoLm1heChmZWF0dXJlLm1heFksIGdlb21baSArIDFdKTtcbiAgICB9XG59XG4iLCJcbmltcG9ydCBzaW1wbGlmeSBmcm9tICcuL3NpbXBsaWZ5JztcbmltcG9ydCBjcmVhdGVGZWF0dXJlIGZyb20gJy4vZmVhdHVyZSc7XG5cbi8vIGNvbnZlcnRzIEdlb0pTT04gZmVhdHVyZSBpbnRvIGFuIGludGVybWVkaWF0ZSBwcm9qZWN0ZWQgSlNPTiB2ZWN0b3IgZm9ybWF0IHdpdGggc2ltcGxpZmljYXRpb24gZGF0YVxuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiBjb252ZXJ0KGRhdGEsIG9wdGlvbnMpIHtcbiAgICB2YXIgZmVhdHVyZXMgPSBbXTtcbiAgICBpZiAoZGF0YS50eXBlID09PSAnRmVhdHVyZUNvbGxlY3Rpb24nKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZGF0YS5mZWF0dXJlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgY29udmVydEZlYXR1cmUoZmVhdHVyZXMsIGRhdGEuZmVhdHVyZXNbaV0sIG9wdGlvbnMsIGkpO1xuICAgICAgICB9XG5cbiAgICB9IGVsc2UgaWYgKGRhdGEudHlwZSA9PT0gJ0ZlYXR1cmUnKSB7XG4gICAgICAgIGNvbnZlcnRGZWF0dXJlKGZlYXR1cmVzLCBkYXRhLCBvcHRpb25zKTtcblxuICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIHNpbmdsZSBnZW9tZXRyeSBvciBhIGdlb21ldHJ5IGNvbGxlY3Rpb25cbiAgICAgICAgY29udmVydEZlYXR1cmUoZmVhdHVyZXMsIHtnZW9tZXRyeTogZGF0YX0sIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIHJldHVybiBmZWF0dXJlcztcbn1cblxuZnVuY3Rpb24gY29udmVydEZlYXR1cmUoZmVhdHVyZXMsIGdlb2pzb24sIG9wdGlvbnMsIGluZGV4KSB7XG4gICAgaWYgKCFnZW9qc29uLmdlb21ldHJ5KSByZXR1cm47XG5cbiAgICB2YXIgY29vcmRzID0gZ2VvanNvbi5nZW9tZXRyeS5jb29yZGluYXRlcztcbiAgICB2YXIgdHlwZSA9IGdlb2pzb24uZ2VvbWV0cnkudHlwZTtcbiAgICB2YXIgdG9sZXJhbmNlID0gTWF0aC5wb3cob3B0aW9ucy50b2xlcmFuY2UgLyAoKDEgPDwgb3B0aW9ucy5tYXhab29tKSAqIG9wdGlvbnMuZXh0ZW50KSwgMik7XG4gICAgdmFyIGdlb21ldHJ5ID0gW107XG4gICAgdmFyIGlkID0gZ2VvanNvbi5pZDtcbiAgICBpZiAob3B0aW9ucy5wcm9tb3RlSWQpIHtcbiAgICAgICAgaWQgPSBnZW9qc29uLnByb3BlcnRpZXNbb3B0aW9ucy5wcm9tb3RlSWRdO1xuICAgIH0gZWxzZSBpZiAob3B0aW9ucy5nZW5lcmF0ZUlkKSB7XG4gICAgICAgIGlkID0gaW5kZXggfHwgMDtcbiAgICB9XG4gICAgaWYgKHR5cGUgPT09ICdQb2ludCcpIHtcbiAgICAgICAgY29udmVydFBvaW50KGNvb3JkcywgZ2VvbWV0cnkpO1xuXG4gICAgfSBlbHNlIGlmICh0eXBlID09PSAnTXVsdGlQb2ludCcpIHtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjb29yZHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIGNvbnZlcnRQb2ludChjb29yZHNbaV0sIGdlb21ldHJ5KTtcbiAgICAgICAgfVxuXG4gICAgfSBlbHNlIGlmICh0eXBlID09PSAnTGluZVN0cmluZycpIHtcbiAgICAgICAgY29udmVydExpbmUoY29vcmRzLCBnZW9tZXRyeSwgdG9sZXJhbmNlLCBmYWxzZSk7XG5cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdNdWx0aUxpbmVTdHJpbmcnKSB7XG4gICAgICAgIGlmIChvcHRpb25zLmxpbmVNZXRyaWNzKSB7XG4gICAgICAgICAgICAvLyBleHBsb2RlIGludG8gbGluZXN0cmluZ3MgdG8gYmUgYWJsZSB0byB0cmFjayBtZXRyaWNzXG4gICAgICAgICAgICBmb3IgKGkgPSAwOyBpIDwgY29vcmRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgZ2VvbWV0cnkgPSBbXTtcbiAgICAgICAgICAgICAgICBjb252ZXJ0TGluZShjb29yZHNbaV0sIGdlb21ldHJ5LCB0b2xlcmFuY2UsIGZhbHNlKTtcbiAgICAgICAgICAgICAgICBmZWF0dXJlcy5wdXNoKGNyZWF0ZUZlYXR1cmUoaWQsICdMaW5lU3RyaW5nJywgZ2VvbWV0cnksIGdlb2pzb24ucHJvcGVydGllcykpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29udmVydExpbmVzKGNvb3JkcywgZ2VvbWV0cnksIHRvbGVyYW5jZSwgZmFsc2UpO1xuICAgICAgICB9XG5cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdQb2x5Z29uJykge1xuICAgICAgICBjb252ZXJ0TGluZXMoY29vcmRzLCBnZW9tZXRyeSwgdG9sZXJhbmNlLCB0cnVlKTtcblxuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ011bHRpUG9seWdvbicpIHtcbiAgICAgICAgZm9yIChpID0gMDsgaSA8IGNvb3Jkcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgdmFyIHBvbHlnb24gPSBbXTtcbiAgICAgICAgICAgIGNvbnZlcnRMaW5lcyhjb29yZHNbaV0sIHBvbHlnb24sIHRvbGVyYW5jZSwgdHJ1ZSk7XG4gICAgICAgICAgICBnZW9tZXRyeS5wdXNoKHBvbHlnb24pO1xuICAgICAgICB9XG4gICAgfSBlbHNlIGlmICh0eXBlID09PSAnR2VvbWV0cnlDb2xsZWN0aW9uJykge1xuICAgICAgICBmb3IgKGkgPSAwOyBpIDwgZ2VvanNvbi5nZW9tZXRyeS5nZW9tZXRyaWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBjb252ZXJ0RmVhdHVyZShmZWF0dXJlcywge1xuICAgICAgICAgICAgICAgIGlkOiBpZCxcbiAgICAgICAgICAgICAgICBnZW9tZXRyeTogZ2VvanNvbi5nZW9tZXRyeS5nZW9tZXRyaWVzW2ldLFxuICAgICAgICAgICAgICAgIHByb3BlcnRpZXM6IGdlb2pzb24ucHJvcGVydGllc1xuICAgICAgICAgICAgfSwgb3B0aW9ucywgaW5kZXgpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0lucHV0IGRhdGEgaXMgbm90IGEgdmFsaWQgR2VvSlNPTiBvYmplY3QuJyk7XG4gICAgfVxuXG4gICAgZmVhdHVyZXMucHVzaChjcmVhdGVGZWF0dXJlKGlkLCB0eXBlLCBnZW9tZXRyeSwgZ2VvanNvbi5wcm9wZXJ0aWVzKSk7XG59XG5cbmZ1bmN0aW9uIGNvbnZlcnRQb2ludChjb29yZHMsIG91dCkge1xuICAgIG91dC5wdXNoKHByb2plY3RYKGNvb3Jkc1swXSkpO1xuICAgIG91dC5wdXNoKHByb2plY3RZKGNvb3Jkc1sxXSkpO1xuICAgIG91dC5wdXNoKDApO1xufVxuXG5mdW5jdGlvbiBjb252ZXJ0TGluZShyaW5nLCBvdXQsIHRvbGVyYW5jZSwgaXNQb2x5Z29uKSB7XG4gICAgdmFyIHgwLCB5MDtcbiAgICB2YXIgc2l6ZSA9IDA7XG5cbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IHJpbmcubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgdmFyIHggPSBwcm9qZWN0WChyaW5nW2pdWzBdKTtcbiAgICAgICAgdmFyIHkgPSBwcm9qZWN0WShyaW5nW2pdWzFdKTtcblxuICAgICAgICBvdXQucHVzaCh4KTtcbiAgICAgICAgb3V0LnB1c2goeSk7XG4gICAgICAgIG91dC5wdXNoKDApO1xuXG4gICAgICAgIGlmIChqID4gMCkge1xuICAgICAgICAgICAgaWYgKGlzUG9seWdvbikge1xuICAgICAgICAgICAgICAgIHNpemUgKz0gKHgwICogeSAtIHggKiB5MCkgLyAyOyAvLyBhcmVhXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNpemUgKz0gTWF0aC5zcXJ0KE1hdGgucG93KHggLSB4MCwgMikgKyBNYXRoLnBvdyh5IC0geTAsIDIpKTsgLy8gbGVuZ3RoXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgeDAgPSB4O1xuICAgICAgICB5MCA9IHk7XG4gICAgfVxuXG4gICAgdmFyIGxhc3QgPSBvdXQubGVuZ3RoIC0gMztcbiAgICBvdXRbMl0gPSAxO1xuICAgIHNpbXBsaWZ5KG91dCwgMCwgbGFzdCwgdG9sZXJhbmNlKTtcbiAgICBvdXRbbGFzdCArIDJdID0gMTtcblxuICAgIG91dC5zaXplID0gTWF0aC5hYnMoc2l6ZSk7XG4gICAgb3V0LnN0YXJ0ID0gMDtcbiAgICBvdXQuZW5kID0gb3V0LnNpemU7XG59XG5cbmZ1bmN0aW9uIGNvbnZlcnRMaW5lcyhyaW5ncywgb3V0LCB0b2xlcmFuY2UsIGlzUG9seWdvbikge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcmluZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyIGdlb20gPSBbXTtcbiAgICAgICAgY29udmVydExpbmUocmluZ3NbaV0sIGdlb20sIHRvbGVyYW5jZSwgaXNQb2x5Z29uKTtcbiAgICAgICAgb3V0LnB1c2goZ2VvbSk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBwcm9qZWN0WCh4KSB7XG4gICAgcmV0dXJuIHggLyAzNjAgKyAwLjU7XG59XG5cbmZ1bmN0aW9uIHByb2plY3RZKHkpIHtcbiAgICB2YXIgc2luID0gTWF0aC5zaW4oeSAqIE1hdGguUEkgLyAxODApO1xuICAgIHZhciB5MiA9IDAuNSAtIDAuMjUgKiBNYXRoLmxvZygoMSArIHNpbikgLyAoMSAtIHNpbikpIC8gTWF0aC5QSTtcbiAgICByZXR1cm4geTIgPCAwID8gMCA6IHkyID4gMSA/IDEgOiB5Mjtcbn1cbiIsIlxuaW1wb3J0IGNyZWF0ZUZlYXR1cmUgZnJvbSAnLi9mZWF0dXJlJztcblxuLyogY2xpcCBmZWF0dXJlcyBiZXR3ZWVuIHR3byBheGlzLXBhcmFsbGVsIGxpbmVzOlxuICogICAgIHwgICAgICAgIHxcbiAqICBfX198X19fICAgICB8ICAgICAvXG4gKiAvICAgfCAgIFxcX19fX3xfX19fL1xuICogICAgIHwgICAgICAgIHxcbiAqL1xuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiBjbGlwKGZlYXR1cmVzLCBzY2FsZSwgazEsIGsyLCBheGlzLCBtaW5BbGwsIG1heEFsbCwgb3B0aW9ucykge1xuXG4gICAgazEgLz0gc2NhbGU7XG4gICAgazIgLz0gc2NhbGU7XG5cbiAgICBpZiAobWluQWxsID49IGsxICYmIG1heEFsbCA8IGsyKSByZXR1cm4gZmVhdHVyZXM7IC8vIHRyaXZpYWwgYWNjZXB0XG4gICAgZWxzZSBpZiAobWF4QWxsIDwgazEgfHwgbWluQWxsID49IGsyKSByZXR1cm4gbnVsbDsgLy8gdHJpdmlhbCByZWplY3RcblxuICAgIHZhciBjbGlwcGVkID0gW107XG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGZlYXR1cmVzLmxlbmd0aDsgaSsrKSB7XG5cbiAgICAgICAgdmFyIGZlYXR1cmUgPSBmZWF0dXJlc1tpXTtcbiAgICAgICAgdmFyIGdlb21ldHJ5ID0gZmVhdHVyZS5nZW9tZXRyeTtcbiAgICAgICAgdmFyIHR5cGUgPSBmZWF0dXJlLnR5cGU7XG5cbiAgICAgICAgdmFyIG1pbiA9IGF4aXMgPT09IDAgPyBmZWF0dXJlLm1pblggOiBmZWF0dXJlLm1pblk7XG4gICAgICAgIHZhciBtYXggPSBheGlzID09PSAwID8gZmVhdHVyZS5tYXhYIDogZmVhdHVyZS5tYXhZO1xuXG4gICAgICAgIGlmIChtaW4gPj0gazEgJiYgbWF4IDwgazIpIHsgLy8gdHJpdmlhbCBhY2NlcHRcbiAgICAgICAgICAgIGNsaXBwZWQucHVzaChmZWF0dXJlKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9IGVsc2UgaWYgKG1heCA8IGsxIHx8IG1pbiA+PSBrMikgeyAvLyB0cml2aWFsIHJlamVjdFxuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgbmV3R2VvbWV0cnkgPSBbXTtcblxuICAgICAgICBpZiAodHlwZSA9PT0gJ1BvaW50JyB8fCB0eXBlID09PSAnTXVsdGlQb2ludCcpIHtcbiAgICAgICAgICAgIGNsaXBQb2ludHMoZ2VvbWV0cnksIG5ld0dlb21ldHJ5LCBrMSwgazIsIGF4aXMpO1xuXG4gICAgICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ0xpbmVTdHJpbmcnKSB7XG4gICAgICAgICAgICBjbGlwTGluZShnZW9tZXRyeSwgbmV3R2VvbWV0cnksIGsxLCBrMiwgYXhpcywgZmFsc2UsIG9wdGlvbnMubGluZU1ldHJpY3MpO1xuXG4gICAgICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ011bHRpTGluZVN0cmluZycpIHtcbiAgICAgICAgICAgIGNsaXBMaW5lcyhnZW9tZXRyeSwgbmV3R2VvbWV0cnksIGsxLCBrMiwgYXhpcywgZmFsc2UpO1xuXG4gICAgICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgICAgICBjbGlwTGluZXMoZ2VvbWV0cnksIG5ld0dlb21ldHJ5LCBrMSwgazIsIGF4aXMsIHRydWUpO1xuXG4gICAgICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ011bHRpUG9seWdvbicpIHtcbiAgICAgICAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgZ2VvbWV0cnkubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICAgICAgICB2YXIgcG9seWdvbiA9IFtdO1xuICAgICAgICAgICAgICAgIGNsaXBMaW5lcyhnZW9tZXRyeVtqXSwgcG9seWdvbiwgazEsIGsyLCBheGlzLCB0cnVlKTtcbiAgICAgICAgICAgICAgICBpZiAocG9seWdvbi5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgbmV3R2VvbWV0cnkucHVzaChwb2x5Z29uKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobmV3R2VvbWV0cnkubGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAob3B0aW9ucy5saW5lTWV0cmljcyAmJiB0eXBlID09PSAnTGluZVN0cmluZycpIHtcbiAgICAgICAgICAgICAgICBmb3IgKGogPSAwOyBqIDwgbmV3R2VvbWV0cnkubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgICAgICAgICAgICAgY2xpcHBlZC5wdXNoKGNyZWF0ZUZlYXR1cmUoZmVhdHVyZS5pZCwgdHlwZSwgbmV3R2VvbWV0cnlbal0sIGZlYXR1cmUudGFncykpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHR5cGUgPT09ICdMaW5lU3RyaW5nJyB8fCB0eXBlID09PSAnTXVsdGlMaW5lU3RyaW5nJykge1xuICAgICAgICAgICAgICAgIGlmIChuZXdHZW9tZXRyeS5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZSA9ICdMaW5lU3RyaW5nJztcbiAgICAgICAgICAgICAgICAgICAgbmV3R2VvbWV0cnkgPSBuZXdHZW9tZXRyeVswXTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0eXBlID0gJ011bHRpTGluZVN0cmluZyc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHR5cGUgPT09ICdQb2ludCcgfHwgdHlwZSA9PT0gJ011bHRpUG9pbnQnKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IG5ld0dlb21ldHJ5Lmxlbmd0aCA9PT0gMyA/ICdQb2ludCcgOiAnTXVsdGlQb2ludCc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNsaXBwZWQucHVzaChjcmVhdGVGZWF0dXJlKGZlYXR1cmUuaWQsIHR5cGUsIG5ld0dlb21ldHJ5LCBmZWF0dXJlLnRhZ3MpKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBjbGlwcGVkLmxlbmd0aCA/IGNsaXBwZWQgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBjbGlwUG9pbnRzKGdlb20sIG5ld0dlb20sIGsxLCBrMiwgYXhpcykge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZ2VvbS5sZW5ndGg7IGkgKz0gMykge1xuICAgICAgICB2YXIgYSA9IGdlb21baSArIGF4aXNdO1xuXG4gICAgICAgIGlmIChhID49IGsxICYmIGEgPD0gazIpIHtcbiAgICAgICAgICAgIG5ld0dlb20ucHVzaChnZW9tW2ldKTtcbiAgICAgICAgICAgIG5ld0dlb20ucHVzaChnZW9tW2kgKyAxXSk7XG4gICAgICAgICAgICBuZXdHZW9tLnB1c2goZ2VvbVtpICsgMl0pO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5mdW5jdGlvbiBjbGlwTGluZShnZW9tLCBuZXdHZW9tLCBrMSwgazIsIGF4aXMsIGlzUG9seWdvbiwgdHJhY2tNZXRyaWNzKSB7XG5cbiAgICB2YXIgc2xpY2UgPSBuZXdTbGljZShnZW9tKTtcbiAgICB2YXIgaW50ZXJzZWN0ID0gYXhpcyA9PT0gMCA/IGludGVyc2VjdFggOiBpbnRlcnNlY3RZO1xuICAgIHZhciBsZW4gPSBnZW9tLnN0YXJ0O1xuICAgIHZhciBzZWdMZW4sIHQ7XG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGdlb20ubGVuZ3RoIC0gMzsgaSArPSAzKSB7XG4gICAgICAgIHZhciBheCA9IGdlb21baV07XG4gICAgICAgIHZhciBheSA9IGdlb21baSArIDFdO1xuICAgICAgICB2YXIgYXogPSBnZW9tW2kgKyAyXTtcbiAgICAgICAgdmFyIGJ4ID0gZ2VvbVtpICsgM107XG4gICAgICAgIHZhciBieSA9IGdlb21baSArIDRdO1xuICAgICAgICB2YXIgYSA9IGF4aXMgPT09IDAgPyBheCA6IGF5O1xuICAgICAgICB2YXIgYiA9IGF4aXMgPT09IDAgPyBieCA6IGJ5O1xuICAgICAgICB2YXIgZXhpdGVkID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKHRyYWNrTWV0cmljcykgc2VnTGVuID0gTWF0aC5zcXJ0KE1hdGgucG93KGF4IC0gYngsIDIpICsgTWF0aC5wb3coYXkgLSBieSwgMikpO1xuXG4gICAgICAgIGlmIChhIDwgazEpIHtcbiAgICAgICAgICAgIC8vIC0tLXwtLT4gIHwgKGxpbmUgZW50ZXJzIHRoZSBjbGlwIHJlZ2lvbiBmcm9tIHRoZSBsZWZ0KVxuICAgICAgICAgICAgaWYgKGIgPiBrMSkge1xuICAgICAgICAgICAgICAgIHQgPSBpbnRlcnNlY3Qoc2xpY2UsIGF4LCBheSwgYngsIGJ5LCBrMSk7XG4gICAgICAgICAgICAgICAgaWYgKHRyYWNrTWV0cmljcykgc2xpY2Uuc3RhcnQgPSBsZW4gKyBzZWdMZW4gKiB0O1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKGEgPiBrMikge1xuICAgICAgICAgICAgLy8gfCAgPC0tfC0tLSAobGluZSBlbnRlcnMgdGhlIGNsaXAgcmVnaW9uIGZyb20gdGhlIHJpZ2h0KVxuICAgICAgICAgICAgaWYgKGIgPCBrMikge1xuICAgICAgICAgICAgICAgIHQgPSBpbnRlcnNlY3Qoc2xpY2UsIGF4LCBheSwgYngsIGJ5LCBrMik7XG4gICAgICAgICAgICAgICAgaWYgKHRyYWNrTWV0cmljcykgc2xpY2Uuc3RhcnQgPSBsZW4gKyBzZWdMZW4gKiB0O1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYWRkUG9pbnQoc2xpY2UsIGF4LCBheSwgYXopO1xuICAgICAgICB9XG4gICAgICAgIGlmIChiIDwgazEgJiYgYSA+PSBrMSkge1xuICAgICAgICAgICAgLy8gPC0tfC0tLSAgfCBvciA8LS18LS0tLS18LS0tIChsaW5lIGV4aXRzIHRoZSBjbGlwIHJlZ2lvbiBvbiB0aGUgbGVmdClcbiAgICAgICAgICAgIHQgPSBpbnRlcnNlY3Qoc2xpY2UsIGF4LCBheSwgYngsIGJ5LCBrMSk7XG4gICAgICAgICAgICBleGl0ZWQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChiID4gazIgJiYgYSA8PSBrMikge1xuICAgICAgICAgICAgLy8gfCAgLS0tfC0tPiBvciAtLS18LS0tLS18LS0+IChsaW5lIGV4aXRzIHRoZSBjbGlwIHJlZ2lvbiBvbiB0aGUgcmlnaHQpXG4gICAgICAgICAgICB0ID0gaW50ZXJzZWN0KHNsaWNlLCBheCwgYXksIGJ4LCBieSwgazIpO1xuICAgICAgICAgICAgZXhpdGVkID0gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghaXNQb2x5Z29uICYmIGV4aXRlZCkge1xuICAgICAgICAgICAgaWYgKHRyYWNrTWV0cmljcykgc2xpY2UuZW5kID0gbGVuICsgc2VnTGVuICogdDtcbiAgICAgICAgICAgIG5ld0dlb20ucHVzaChzbGljZSk7XG4gICAgICAgICAgICBzbGljZSA9IG5ld1NsaWNlKGdlb20pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRyYWNrTWV0cmljcykgbGVuICs9IHNlZ0xlbjtcbiAgICB9XG5cbiAgICAvLyBhZGQgdGhlIGxhc3QgcG9pbnRcbiAgICB2YXIgbGFzdCA9IGdlb20ubGVuZ3RoIC0gMztcbiAgICBheCA9IGdlb21bbGFzdF07XG4gICAgYXkgPSBnZW9tW2xhc3QgKyAxXTtcbiAgICBheiA9IGdlb21bbGFzdCArIDJdO1xuICAgIGEgPSBheGlzID09PSAwID8gYXggOiBheTtcbiAgICBpZiAoYSA+PSBrMSAmJiBhIDw9IGsyKSBhZGRQb2ludChzbGljZSwgYXgsIGF5LCBheik7XG5cbiAgICAvLyBjbG9zZSB0aGUgcG9seWdvbiBpZiBpdHMgZW5kcG9pbnRzIGFyZSBub3QgdGhlIHNhbWUgYWZ0ZXIgY2xpcHBpbmdcbiAgICBsYXN0ID0gc2xpY2UubGVuZ3RoIC0gMztcbiAgICBpZiAoaXNQb2x5Z29uICYmIGxhc3QgPj0gMyAmJiAoc2xpY2VbbGFzdF0gIT09IHNsaWNlWzBdIHx8IHNsaWNlW2xhc3QgKyAxXSAhPT0gc2xpY2VbMV0pKSB7XG4gICAgICAgIGFkZFBvaW50KHNsaWNlLCBzbGljZVswXSwgc2xpY2VbMV0sIHNsaWNlWzJdKTtcbiAgICB9XG5cbiAgICAvLyBhZGQgdGhlIGZpbmFsIHNsaWNlXG4gICAgaWYgKHNsaWNlLmxlbmd0aCkge1xuICAgICAgICBuZXdHZW9tLnB1c2goc2xpY2UpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gbmV3U2xpY2UobGluZSkge1xuICAgIHZhciBzbGljZSA9IFtdO1xuICAgIHNsaWNlLnNpemUgPSBsaW5lLnNpemU7XG4gICAgc2xpY2Uuc3RhcnQgPSBsaW5lLnN0YXJ0O1xuICAgIHNsaWNlLmVuZCA9IGxpbmUuZW5kO1xuICAgIHJldHVybiBzbGljZTtcbn1cblxuZnVuY3Rpb24gY2xpcExpbmVzKGdlb20sIG5ld0dlb20sIGsxLCBrMiwgYXhpcywgaXNQb2x5Z29uKSB7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBnZW9tLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNsaXBMaW5lKGdlb21baV0sIG5ld0dlb20sIGsxLCBrMiwgYXhpcywgaXNQb2x5Z29uLCBmYWxzZSk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBhZGRQb2ludChvdXQsIHgsIHksIHopIHtcbiAgICBvdXQucHVzaCh4KTtcbiAgICBvdXQucHVzaCh5KTtcbiAgICBvdXQucHVzaCh6KTtcbn1cblxuZnVuY3Rpb24gaW50ZXJzZWN0WChvdXQsIGF4LCBheSwgYngsIGJ5LCB4KSB7XG4gICAgdmFyIHQgPSAoeCAtIGF4KSAvIChieCAtIGF4KTtcbiAgICBvdXQucHVzaCh4KTtcbiAgICBvdXQucHVzaChheSArIChieSAtIGF5KSAqIHQpO1xuICAgIG91dC5wdXNoKDEpO1xuICAgIHJldHVybiB0O1xufVxuXG5mdW5jdGlvbiBpbnRlcnNlY3RZKG91dCwgYXgsIGF5LCBieCwgYnksIHkpIHtcbiAgICB2YXIgdCA9ICh5IC0gYXkpIC8gKGJ5IC0gYXkpO1xuICAgIG91dC5wdXNoKGF4ICsgKGJ4IC0gYXgpICogdCk7XG4gICAgb3V0LnB1c2goeSk7XG4gICAgb3V0LnB1c2goMSk7XG4gICAgcmV0dXJuIHQ7XG59XG4iLCJcbmltcG9ydCBjbGlwIGZyb20gJy4vY2xpcCc7XG5pbXBvcnQgY3JlYXRlRmVhdHVyZSBmcm9tICcuL2ZlYXR1cmUnO1xuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiB3cmFwKGZlYXR1cmVzLCBvcHRpb25zKSB7XG4gICAgdmFyIGJ1ZmZlciA9IG9wdGlvbnMuYnVmZmVyIC8gb3B0aW9ucy5leHRlbnQ7XG4gICAgdmFyIG1lcmdlZCA9IGZlYXR1cmVzO1xuICAgIHZhciBsZWZ0ICA9IGNsaXAoZmVhdHVyZXMsIDEsIC0xIC0gYnVmZmVyLCBidWZmZXIsICAgICAwLCAtMSwgMiwgb3B0aW9ucyk7IC8vIGxlZnQgd29ybGQgY29weVxuICAgIHZhciByaWdodCA9IGNsaXAoZmVhdHVyZXMsIDEsICAxIC0gYnVmZmVyLCAyICsgYnVmZmVyLCAwLCAtMSwgMiwgb3B0aW9ucyk7IC8vIHJpZ2h0IHdvcmxkIGNvcHlcblxuICAgIGlmIChsZWZ0IHx8IHJpZ2h0KSB7XG4gICAgICAgIG1lcmdlZCA9IGNsaXAoZmVhdHVyZXMsIDEsIC1idWZmZXIsIDEgKyBidWZmZXIsIDAsIC0xLCAyLCBvcHRpb25zKSB8fCBbXTsgLy8gY2VudGVyIHdvcmxkIGNvcHlcblxuICAgICAgICBpZiAobGVmdCkgbWVyZ2VkID0gc2hpZnRGZWF0dXJlQ29vcmRzKGxlZnQsIDEpLmNvbmNhdChtZXJnZWQpOyAvLyBtZXJnZSBsZWZ0IGludG8gY2VudGVyXG4gICAgICAgIGlmIChyaWdodCkgbWVyZ2VkID0gbWVyZ2VkLmNvbmNhdChzaGlmdEZlYXR1cmVDb29yZHMocmlnaHQsIC0xKSk7IC8vIG1lcmdlIHJpZ2h0IGludG8gY2VudGVyXG4gICAgfVxuXG4gICAgcmV0dXJuIG1lcmdlZDtcbn1cblxuZnVuY3Rpb24gc2hpZnRGZWF0dXJlQ29vcmRzKGZlYXR1cmVzLCBvZmZzZXQpIHtcbiAgICB2YXIgbmV3RmVhdHVyZXMgPSBbXTtcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmVhdHVyZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyIGZlYXR1cmUgPSBmZWF0dXJlc1tpXSxcbiAgICAgICAgICAgIHR5cGUgPSBmZWF0dXJlLnR5cGU7XG5cbiAgICAgICAgdmFyIG5ld0dlb21ldHJ5O1xuXG4gICAgICAgIGlmICh0eXBlID09PSAnUG9pbnQnIHx8IHR5cGUgPT09ICdNdWx0aVBvaW50JyB8fCB0eXBlID09PSAnTGluZVN0cmluZycpIHtcbiAgICAgICAgICAgIG5ld0dlb21ldHJ5ID0gc2hpZnRDb29yZHMoZmVhdHVyZS5nZW9tZXRyeSwgb2Zmc2V0KTtcblxuICAgICAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdNdWx0aUxpbmVTdHJpbmcnIHx8IHR5cGUgPT09ICdQb2x5Z29uJykge1xuICAgICAgICAgICAgbmV3R2VvbWV0cnkgPSBbXTtcbiAgICAgICAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgZmVhdHVyZS5nZW9tZXRyeS5sZW5ndGg7IGorKykge1xuICAgICAgICAgICAgICAgIG5ld0dlb21ldHJ5LnB1c2goc2hpZnRDb29yZHMoZmVhdHVyZS5nZW9tZXRyeVtqXSwgb2Zmc2V0KSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ011bHRpUG9seWdvbicpIHtcbiAgICAgICAgICAgIG5ld0dlb21ldHJ5ID0gW107XG4gICAgICAgICAgICBmb3IgKGogPSAwOyBqIDwgZmVhdHVyZS5nZW9tZXRyeS5sZW5ndGg7IGorKykge1xuICAgICAgICAgICAgICAgIHZhciBuZXdQb2x5Z29uID0gW107XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgayA9IDA7IGsgPCBmZWF0dXJlLmdlb21ldHJ5W2pdLmxlbmd0aDsgaysrKSB7XG4gICAgICAgICAgICAgICAgICAgIG5ld1BvbHlnb24ucHVzaChzaGlmdENvb3JkcyhmZWF0dXJlLmdlb21ldHJ5W2pdW2tdLCBvZmZzZXQpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbmV3R2VvbWV0cnkucHVzaChuZXdQb2x5Z29uKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIG5ld0ZlYXR1cmVzLnB1c2goY3JlYXRlRmVhdHVyZShmZWF0dXJlLmlkLCB0eXBlLCBuZXdHZW9tZXRyeSwgZmVhdHVyZS50YWdzKSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIG5ld0ZlYXR1cmVzO1xufVxuXG5mdW5jdGlvbiBzaGlmdENvb3Jkcyhwb2ludHMsIG9mZnNldCkge1xuICAgIHZhciBuZXdQb2ludHMgPSBbXTtcbiAgICBuZXdQb2ludHMuc2l6ZSA9IHBvaW50cy5zaXplO1xuXG4gICAgaWYgKHBvaW50cy5zdGFydCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIG5ld1BvaW50cy5zdGFydCA9IHBvaW50cy5zdGFydDtcbiAgICAgICAgbmV3UG9pbnRzLmVuZCA9IHBvaW50cy5lbmQ7XG4gICAgfVxuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwb2ludHMubGVuZ3RoOyBpICs9IDMpIHtcbiAgICAgICAgbmV3UG9pbnRzLnB1c2gocG9pbnRzW2ldICsgb2Zmc2V0LCBwb2ludHNbaSArIDFdLCBwb2ludHNbaSArIDJdKTtcbiAgICB9XG4gICAgcmV0dXJuIG5ld1BvaW50cztcbn1cbiIsIlxuLy8gVHJhbnNmb3JtcyB0aGUgY29vcmRpbmF0ZXMgb2YgZWFjaCBmZWF0dXJlIGluIHRoZSBnaXZlbiB0aWxlIGZyb21cbi8vIG1lcmNhdG9yLXByb2plY3RlZCBzcGFjZSBpbnRvIChleHRlbnQgeCBleHRlbnQpIHRpbGUgc3BhY2UuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiB0cmFuc2Zvcm1UaWxlKHRpbGUsIGV4dGVudCkge1xuICAgIGlmICh0aWxlLnRyYW5zZm9ybWVkKSByZXR1cm4gdGlsZTtcblxuICAgIHZhciB6MiA9IDEgPDwgdGlsZS56LFxuICAgICAgICB0eCA9IHRpbGUueCxcbiAgICAgICAgdHkgPSB0aWxlLnksXG4gICAgICAgIGksIGosIGs7XG5cbiAgICBmb3IgKGkgPSAwOyBpIDwgdGlsZS5mZWF0dXJlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICB2YXIgZmVhdHVyZSA9IHRpbGUuZmVhdHVyZXNbaV0sXG4gICAgICAgICAgICBnZW9tID0gZmVhdHVyZS5nZW9tZXRyeSxcbiAgICAgICAgICAgIHR5cGUgPSBmZWF0dXJlLnR5cGU7XG5cbiAgICAgICAgZmVhdHVyZS5nZW9tZXRyeSA9IFtdO1xuXG4gICAgICAgIGlmICh0eXBlID09PSAxKSB7XG4gICAgICAgICAgICBmb3IgKGogPSAwOyBqIDwgZ2VvbS5sZW5ndGg7IGogKz0gMikge1xuICAgICAgICAgICAgICAgIGZlYXR1cmUuZ2VvbWV0cnkucHVzaCh0cmFuc2Zvcm1Qb2ludChnZW9tW2pdLCBnZW9tW2ogKyAxXSwgZXh0ZW50LCB6MiwgdHgsIHR5KSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBmb3IgKGogPSAwOyBqIDwgZ2VvbS5sZW5ndGg7IGorKykge1xuICAgICAgICAgICAgICAgIHZhciByaW5nID0gW107XG4gICAgICAgICAgICAgICAgZm9yIChrID0gMDsgayA8IGdlb21bal0ubGVuZ3RoOyBrICs9IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgcmluZy5wdXNoKHRyYW5zZm9ybVBvaW50KGdlb21bal1ba10sIGdlb21bal1bayArIDFdLCBleHRlbnQsIHoyLCB0eCwgdHkpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZmVhdHVyZS5nZW9tZXRyeS5wdXNoKHJpbmcpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgdGlsZS50cmFuc2Zvcm1lZCA9IHRydWU7XG5cbiAgICByZXR1cm4gdGlsZTtcbn1cblxuZnVuY3Rpb24gdHJhbnNmb3JtUG9pbnQoeCwgeSwgZXh0ZW50LCB6MiwgdHgsIHR5KSB7XG4gICAgcmV0dXJuIFtcbiAgICAgICAgTWF0aC5yb3VuZChleHRlbnQgKiAoeCAqIHoyIC0gdHgpKSxcbiAgICAgICAgTWF0aC5yb3VuZChleHRlbnQgKiAoeSAqIHoyIC0gdHkpKV07XG59XG4iLCJcbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIGNyZWF0ZVRpbGUoZmVhdHVyZXMsIHosIHR4LCB0eSwgb3B0aW9ucykge1xuICAgIHZhciB0b2xlcmFuY2UgPSB6ID09PSBvcHRpb25zLm1heFpvb20gPyAwIDogb3B0aW9ucy50b2xlcmFuY2UgLyAoKDEgPDwgeikgKiBvcHRpb25zLmV4dGVudCk7XG4gICAgdmFyIHRpbGUgPSB7XG4gICAgICAgIGZlYXR1cmVzOiBbXSxcbiAgICAgICAgbnVtUG9pbnRzOiAwLFxuICAgICAgICBudW1TaW1wbGlmaWVkOiAwLFxuICAgICAgICBudW1GZWF0dXJlczogMCxcbiAgICAgICAgc291cmNlOiBudWxsLFxuICAgICAgICB4OiB0eCxcbiAgICAgICAgeTogdHksXG4gICAgICAgIHo6IHosXG4gICAgICAgIHRyYW5zZm9ybWVkOiBmYWxzZSxcbiAgICAgICAgbWluWDogMixcbiAgICAgICAgbWluWTogMSxcbiAgICAgICAgbWF4WDogLTEsXG4gICAgICAgIG1heFk6IDBcbiAgICB9O1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZmVhdHVyZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdGlsZS5udW1GZWF0dXJlcysrO1xuICAgICAgICBhZGRGZWF0dXJlKHRpbGUsIGZlYXR1cmVzW2ldLCB0b2xlcmFuY2UsIG9wdGlvbnMpO1xuXG4gICAgICAgIHZhciBtaW5YID0gZmVhdHVyZXNbaV0ubWluWDtcbiAgICAgICAgdmFyIG1pblkgPSBmZWF0dXJlc1tpXS5taW5ZO1xuICAgICAgICB2YXIgbWF4WCA9IGZlYXR1cmVzW2ldLm1heFg7XG4gICAgICAgIHZhciBtYXhZID0gZmVhdHVyZXNbaV0ubWF4WTtcblxuICAgICAgICBpZiAobWluWCA8IHRpbGUubWluWCkgdGlsZS5taW5YID0gbWluWDtcbiAgICAgICAgaWYgKG1pblkgPCB0aWxlLm1pblkpIHRpbGUubWluWSA9IG1pblk7XG4gICAgICAgIGlmIChtYXhYID4gdGlsZS5tYXhYKSB0aWxlLm1heFggPSBtYXhYO1xuICAgICAgICBpZiAobWF4WSA+IHRpbGUubWF4WSkgdGlsZS5tYXhZID0gbWF4WTtcbiAgICB9XG4gICAgcmV0dXJuIHRpbGU7XG59XG5cbmZ1bmN0aW9uIGFkZEZlYXR1cmUodGlsZSwgZmVhdHVyZSwgdG9sZXJhbmNlLCBvcHRpb25zKSB7XG5cbiAgICB2YXIgZ2VvbSA9IGZlYXR1cmUuZ2VvbWV0cnksXG4gICAgICAgIHR5cGUgPSBmZWF0dXJlLnR5cGUsXG4gICAgICAgIHNpbXBsaWZpZWQgPSBbXTtcblxuICAgIGlmICh0eXBlID09PSAnUG9pbnQnIHx8IHR5cGUgPT09ICdNdWx0aVBvaW50Jykge1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGdlb20ubGVuZ3RoOyBpICs9IDMpIHtcbiAgICAgICAgICAgIHNpbXBsaWZpZWQucHVzaChnZW9tW2ldKTtcbiAgICAgICAgICAgIHNpbXBsaWZpZWQucHVzaChnZW9tW2kgKyAxXSk7XG4gICAgICAgICAgICB0aWxlLm51bVBvaW50cysrO1xuICAgICAgICAgICAgdGlsZS5udW1TaW1wbGlmaWVkKys7XG4gICAgICAgIH1cblxuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ0xpbmVTdHJpbmcnKSB7XG4gICAgICAgIGFkZExpbmUoc2ltcGxpZmllZCwgZ2VvbSwgdGlsZSwgdG9sZXJhbmNlLCBmYWxzZSwgZmFsc2UpO1xuXG4gICAgfSBlbHNlIGlmICh0eXBlID09PSAnTXVsdGlMaW5lU3RyaW5nJyB8fCB0eXBlID09PSAnUG9seWdvbicpIHtcbiAgICAgICAgZm9yIChpID0gMDsgaSA8IGdlb20ubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIGFkZExpbmUoc2ltcGxpZmllZCwgZ2VvbVtpXSwgdGlsZSwgdG9sZXJhbmNlLCB0eXBlID09PSAnUG9seWdvbicsIGkgPT09IDApO1xuICAgICAgICB9XG5cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdNdWx0aVBvbHlnb24nKSB7XG5cbiAgICAgICAgZm9yICh2YXIgayA9IDA7IGsgPCBnZW9tLmxlbmd0aDsgaysrKSB7XG4gICAgICAgICAgICB2YXIgcG9seWdvbiA9IGdlb21ba107XG4gICAgICAgICAgICBmb3IgKGkgPSAwOyBpIDwgcG9seWdvbi5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICAgIGFkZExpbmUoc2ltcGxpZmllZCwgcG9seWdvbltpXSwgdGlsZSwgdG9sZXJhbmNlLCB0cnVlLCBpID09PSAwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIGlmIChzaW1wbGlmaWVkLmxlbmd0aCkge1xuICAgICAgICB2YXIgdGFncyA9IGZlYXR1cmUudGFncyB8fCBudWxsO1xuICAgICAgICBpZiAodHlwZSA9PT0gJ0xpbmVTdHJpbmcnICYmIG9wdGlvbnMubGluZU1ldHJpY3MpIHtcbiAgICAgICAgICAgIHRhZ3MgPSB7fTtcbiAgICAgICAgICAgIGZvciAodmFyIGtleSBpbiBmZWF0dXJlLnRhZ3MpIHRhZ3Nba2V5XSA9IGZlYXR1cmUudGFnc1trZXldO1xuICAgICAgICAgICAgdGFnc1snbWFwYm94X2NsaXBfc3RhcnQnXSA9IGdlb20uc3RhcnQgLyBnZW9tLnNpemU7XG4gICAgICAgICAgICB0YWdzWydtYXBib3hfY2xpcF9lbmQnXSA9IGdlb20uZW5kIC8gZ2VvbS5zaXplO1xuICAgICAgICB9XG4gICAgICAgIHZhciB0aWxlRmVhdHVyZSA9IHtcbiAgICAgICAgICAgIGdlb21ldHJ5OiBzaW1wbGlmaWVkLFxuICAgICAgICAgICAgdHlwZTogdHlwZSA9PT0gJ1BvbHlnb24nIHx8IHR5cGUgPT09ICdNdWx0aVBvbHlnb24nID8gMyA6XG4gICAgICAgICAgICAgICAgdHlwZSA9PT0gJ0xpbmVTdHJpbmcnIHx8IHR5cGUgPT09ICdNdWx0aUxpbmVTdHJpbmcnID8gMiA6IDEsXG4gICAgICAgICAgICB0YWdzOiB0YWdzXG4gICAgICAgIH07XG4gICAgICAgIGlmIChmZWF0dXJlLmlkICE9PSBudWxsKSB7XG4gICAgICAgICAgICB0aWxlRmVhdHVyZS5pZCA9IGZlYXR1cmUuaWQ7XG4gICAgICAgIH1cbiAgICAgICAgdGlsZS5mZWF0dXJlcy5wdXNoKHRpbGVGZWF0dXJlKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGFkZExpbmUocmVzdWx0LCBnZW9tLCB0aWxlLCB0b2xlcmFuY2UsIGlzUG9seWdvbiwgaXNPdXRlcikge1xuICAgIHZhciBzcVRvbGVyYW5jZSA9IHRvbGVyYW5jZSAqIHRvbGVyYW5jZTtcblxuICAgIGlmICh0b2xlcmFuY2UgPiAwICYmIChnZW9tLnNpemUgPCAoaXNQb2x5Z29uID8gc3FUb2xlcmFuY2UgOiB0b2xlcmFuY2UpKSkge1xuICAgICAgICB0aWxlLm51bVBvaW50cyArPSBnZW9tLmxlbmd0aCAvIDM7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB2YXIgcmluZyA9IFtdO1xuXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBnZW9tLmxlbmd0aDsgaSArPSAzKSB7XG4gICAgICAgIGlmICh0b2xlcmFuY2UgPT09IDAgfHwgZ2VvbVtpICsgMl0gPiBzcVRvbGVyYW5jZSkge1xuICAgICAgICAgICAgdGlsZS5udW1TaW1wbGlmaWVkKys7XG4gICAgICAgICAgICByaW5nLnB1c2goZ2VvbVtpXSk7XG4gICAgICAgICAgICByaW5nLnB1c2goZ2VvbVtpICsgMV0pO1xuICAgICAgICB9XG4gICAgICAgIHRpbGUubnVtUG9pbnRzKys7XG4gICAgfVxuXG4gICAgaWYgKGlzUG9seWdvbikgcmV3aW5kKHJpbmcsIGlzT3V0ZXIpO1xuXG4gICAgcmVzdWx0LnB1c2gocmluZyk7XG59XG5cbmZ1bmN0aW9uIHJld2luZChyaW5nLCBjbG9ja3dpc2UpIHtcbiAgICB2YXIgYXJlYSA9IDA7XG4gICAgZm9yICh2YXIgaSA9IDAsIGxlbiA9IHJpbmcubGVuZ3RoLCBqID0gbGVuIC0gMjsgaSA8IGxlbjsgaiA9IGksIGkgKz0gMikge1xuICAgICAgICBhcmVhICs9IChyaW5nW2ldIC0gcmluZ1tqXSkgKiAocmluZ1tpICsgMV0gKyByaW5nW2ogKyAxXSk7XG4gICAgfVxuICAgIGlmIChhcmVhID4gMCA9PT0gY2xvY2t3aXNlKSB7XG4gICAgICAgIGZvciAoaSA9IDAsIGxlbiA9IHJpbmcubGVuZ3RoOyBpIDwgbGVuIC8gMjsgaSArPSAyKSB7XG4gICAgICAgICAgICB2YXIgeCA9IHJpbmdbaV07XG4gICAgICAgICAgICB2YXIgeSA9IHJpbmdbaSArIDFdO1xuICAgICAgICAgICAgcmluZ1tpXSA9IHJpbmdbbGVuIC0gMiAtIGldO1xuICAgICAgICAgICAgcmluZ1tpICsgMV0gPSByaW5nW2xlbiAtIDEgLSBpXTtcbiAgICAgICAgICAgIHJpbmdbbGVuIC0gMiAtIGldID0geDtcbiAgICAgICAgICAgIHJpbmdbbGVuIC0gMSAtIGldID0geTtcbiAgICAgICAgfVxuICAgIH1cbn1cbiIsIlxuaW1wb3J0IGNvbnZlcnQgZnJvbSAnLi9jb252ZXJ0JzsgICAgIC8vIEdlb0pTT04gY29udmVyc2lvbiBhbmQgcHJlcHJvY2Vzc2luZ1xuaW1wb3J0IGNsaXAgZnJvbSAnLi9jbGlwJzsgICAgICAgICAgIC8vIHN0cmlwZSBjbGlwcGluZyBhbGdvcml0aG1cbmltcG9ydCB3cmFwIGZyb20gJy4vd3JhcCc7ICAgICAgICAgICAvLyBkYXRlIGxpbmUgcHJvY2Vzc2luZ1xuaW1wb3J0IHRyYW5zZm9ybSBmcm9tICcuL3RyYW5zZm9ybSc7IC8vIGNvb3JkaW5hdGUgdHJhbnNmb3JtYXRpb25cbmltcG9ydCBjcmVhdGVUaWxlIGZyb20gJy4vdGlsZSc7ICAgICAvLyBmaW5hbCBzaW1wbGlmaWVkIHRpbGUgZ2VuZXJhdGlvblxuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiBnZW9qc29udnQoZGF0YSwgb3B0aW9ucykge1xuICAgIHJldHVybiBuZXcgR2VvSlNPTlZUKGRhdGEsIG9wdGlvbnMpO1xufVxuXG5mdW5jdGlvbiBHZW9KU09OVlQoZGF0YSwgb3B0aW9ucykge1xuICAgIG9wdGlvbnMgPSB0aGlzLm9wdGlvbnMgPSBleHRlbmQoT2JqZWN0LmNyZWF0ZSh0aGlzLm9wdGlvbnMpLCBvcHRpb25zKTtcblxuICAgIHZhciBkZWJ1ZyA9IG9wdGlvbnMuZGVidWc7XG5cbiAgICBpZiAoZGVidWcpIGNvbnNvbGUudGltZSgncHJlcHJvY2VzcyBkYXRhJyk7XG5cbiAgICBpZiAob3B0aW9ucy5tYXhab29tIDwgMCB8fCBvcHRpb25zLm1heFpvb20gPiAyNCkgdGhyb3cgbmV3IEVycm9yKCdtYXhab29tIHNob3VsZCBiZSBpbiB0aGUgMC0yNCByYW5nZScpO1xuICAgIGlmIChvcHRpb25zLnByb21vdGVJZCAmJiBvcHRpb25zLmdlbmVyYXRlSWQpIHRocm93IG5ldyBFcnJvcigncHJvbW90ZUlkIGFuZCBnZW5lcmF0ZUlkIGNhbm5vdCBiZSB1c2VkIHRvZ2V0aGVyLicpO1xuXG4gICAgdmFyIGZlYXR1cmVzID0gY29udmVydChkYXRhLCBvcHRpb25zKTtcblxuICAgIHRoaXMudGlsZXMgPSB7fTtcbiAgICB0aGlzLnRpbGVDb29yZHMgPSBbXTtcblxuICAgIGlmIChkZWJ1Zykge1xuICAgICAgICBjb25zb2xlLnRpbWVFbmQoJ3ByZXByb2Nlc3MgZGF0YScpO1xuICAgICAgICBjb25zb2xlLmxvZygnaW5kZXg6IG1heFpvb206ICVkLCBtYXhQb2ludHM6ICVkJywgb3B0aW9ucy5pbmRleE1heFpvb20sIG9wdGlvbnMuaW5kZXhNYXhQb2ludHMpO1xuICAgICAgICBjb25zb2xlLnRpbWUoJ2dlbmVyYXRlIHRpbGVzJyk7XG4gICAgICAgIHRoaXMuc3RhdHMgPSB7fTtcbiAgICAgICAgdGhpcy50b3RhbCA9IDA7XG4gICAgfVxuXG4gICAgZmVhdHVyZXMgPSB3cmFwKGZlYXR1cmVzLCBvcHRpb25zKTtcblxuICAgIC8vIHN0YXJ0IHNsaWNpbmcgZnJvbSB0aGUgdG9wIHRpbGUgZG93blxuICAgIGlmIChmZWF0dXJlcy5sZW5ndGgpIHRoaXMuc3BsaXRUaWxlKGZlYXR1cmVzLCAwLCAwLCAwKTtcblxuICAgIGlmIChkZWJ1Zykge1xuICAgICAgICBpZiAoZmVhdHVyZXMubGVuZ3RoKSBjb25zb2xlLmxvZygnZmVhdHVyZXM6ICVkLCBwb2ludHM6ICVkJywgdGhpcy50aWxlc1swXS5udW1GZWF0dXJlcywgdGhpcy50aWxlc1swXS5udW1Qb2ludHMpO1xuICAgICAgICBjb25zb2xlLnRpbWVFbmQoJ2dlbmVyYXRlIHRpbGVzJyk7XG4gICAgICAgIGNvbnNvbGUubG9nKCd0aWxlcyBnZW5lcmF0ZWQ6JywgdGhpcy50b3RhbCwgSlNPTi5zdHJpbmdpZnkodGhpcy5zdGF0cykpO1xuICAgIH1cbn1cblxuR2VvSlNPTlZULnByb3RvdHlwZS5vcHRpb25zID0ge1xuICAgIG1heFpvb206IDE0LCAgICAgICAgICAgIC8vIG1heCB6b29tIHRvIHByZXNlcnZlIGRldGFpbCBvblxuICAgIGluZGV4TWF4Wm9vbTogNSwgICAgICAgIC8vIG1heCB6b29tIGluIHRoZSB0aWxlIGluZGV4XG4gICAgaW5kZXhNYXhQb2ludHM6IDEwMDAwMCwgLy8gbWF4IG51bWJlciBvZiBwb2ludHMgcGVyIHRpbGUgaW4gdGhlIHRpbGUgaW5kZXhcbiAgICB0b2xlcmFuY2U6IDMsICAgICAgICAgICAvLyBzaW1wbGlmaWNhdGlvbiB0b2xlcmFuY2UgKGhpZ2hlciBtZWFucyBzaW1wbGVyKVxuICAgIGV4dGVudDogNDA5NiwgICAgICAgICAgIC8vIHRpbGUgZXh0ZW50XG4gICAgYnVmZmVyOiA2NCwgICAgICAgICAgICAgLy8gdGlsZSBidWZmZXIgb24gZWFjaCBzaWRlXG4gICAgbGluZU1ldHJpY3M6IGZhbHNlLCAgICAgLy8gd2hldGhlciB0byBjYWxjdWxhdGUgbGluZSBtZXRyaWNzXG4gICAgcHJvbW90ZUlkOiBudWxsLCAgICAgICAgLy8gbmFtZSBvZiBhIGZlYXR1cmUgcHJvcGVydHkgdG8gYmUgcHJvbW90ZWQgdG8gZmVhdHVyZS5pZFxuICAgIGdlbmVyYXRlSWQ6IGZhbHNlLCAgICAgIC8vIHdoZXRoZXIgdG8gZ2VuZXJhdGUgZmVhdHVyZSBpZHMuIENhbm5vdCBiZSB1c2VkIHdpdGggcHJvbW90ZUlkXG4gICAgZGVidWc6IDAgICAgICAgICAgICAgICAgLy8gbG9nZ2luZyBsZXZlbCAoMCwgMSBvciAyKVxufTtcblxuR2VvSlNPTlZULnByb3RvdHlwZS5zcGxpdFRpbGUgPSBmdW5jdGlvbiAoZmVhdHVyZXMsIHosIHgsIHksIGN6LCBjeCwgY3kpIHtcblxuICAgIHZhciBzdGFjayA9IFtmZWF0dXJlcywgeiwgeCwgeV0sXG4gICAgICAgIG9wdGlvbnMgPSB0aGlzLm9wdGlvbnMsXG4gICAgICAgIGRlYnVnID0gb3B0aW9ucy5kZWJ1ZztcblxuICAgIC8vIGF2b2lkIHJlY3Vyc2lvbiBieSB1c2luZyBhIHByb2Nlc3NpbmcgcXVldWVcbiAgICB3aGlsZSAoc3RhY2subGVuZ3RoKSB7XG4gICAgICAgIHkgPSBzdGFjay5wb3AoKTtcbiAgICAgICAgeCA9IHN0YWNrLnBvcCgpO1xuICAgICAgICB6ID0gc3RhY2sucG9wKCk7XG4gICAgICAgIGZlYXR1cmVzID0gc3RhY2sucG9wKCk7XG5cbiAgICAgICAgdmFyIHoyID0gMSA8PCB6LFxuICAgICAgICAgICAgaWQgPSB0b0lEKHosIHgsIHkpLFxuICAgICAgICAgICAgdGlsZSA9IHRoaXMudGlsZXNbaWRdO1xuXG4gICAgICAgIGlmICghdGlsZSkge1xuICAgICAgICAgICAgaWYgKGRlYnVnID4gMSkgY29uc29sZS50aW1lKCdjcmVhdGlvbicpO1xuXG4gICAgICAgICAgICB0aWxlID0gdGhpcy50aWxlc1tpZF0gPSBjcmVhdGVUaWxlKGZlYXR1cmVzLCB6LCB4LCB5LCBvcHRpb25zKTtcbiAgICAgICAgICAgIHRoaXMudGlsZUNvb3Jkcy5wdXNoKHt6OiB6LCB4OiB4LCB5OiB5fSk7XG5cbiAgICAgICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgICAgIGlmIChkZWJ1ZyA+IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coJ3RpbGUgeiVkLSVkLSVkIChmZWF0dXJlczogJWQsIHBvaW50czogJWQsIHNpbXBsaWZpZWQ6ICVkKScsXG4gICAgICAgICAgICAgICAgICAgICAgICB6LCB4LCB5LCB0aWxlLm51bUZlYXR1cmVzLCB0aWxlLm51bVBvaW50cywgdGlsZS5udW1TaW1wbGlmaWVkKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS50aW1lRW5kKCdjcmVhdGlvbicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB2YXIga2V5ID0gJ3onICsgejtcbiAgICAgICAgICAgICAgICB0aGlzLnN0YXRzW2tleV0gPSAodGhpcy5zdGF0c1trZXldIHx8IDApICsgMTtcbiAgICAgICAgICAgICAgICB0aGlzLnRvdGFsKys7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBzYXZlIHJlZmVyZW5jZSB0byBvcmlnaW5hbCBnZW9tZXRyeSBpbiB0aWxlIHNvIHRoYXQgd2UgY2FuIGRyaWxsIGRvd24gbGF0ZXIgaWYgd2Ugc3RvcCBub3dcbiAgICAgICAgdGlsZS5zb3VyY2UgPSBmZWF0dXJlcztcblxuICAgICAgICAvLyBpZiBpdCdzIHRoZSBmaXJzdC1wYXNzIHRpbGluZ1xuICAgICAgICBpZiAoIWN6KSB7XG4gICAgICAgICAgICAvLyBzdG9wIHRpbGluZyBpZiB3ZSByZWFjaGVkIG1heCB6b29tLCBvciBpZiB0aGUgdGlsZSBpcyB0b28gc2ltcGxlXG4gICAgICAgICAgICBpZiAoeiA9PT0gb3B0aW9ucy5pbmRleE1heFpvb20gfHwgdGlsZS5udW1Qb2ludHMgPD0gb3B0aW9ucy5pbmRleE1heFBvaW50cykgY29udGludWU7XG5cbiAgICAgICAgLy8gaWYgYSBkcmlsbGRvd24gdG8gYSBzcGVjaWZpYyB0aWxlXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBzdG9wIHRpbGluZyBpZiB3ZSByZWFjaGVkIGJhc2Ugem9vbSBvciBvdXIgdGFyZ2V0IHRpbGUgem9vbVxuICAgICAgICAgICAgaWYgKHogPT09IG9wdGlvbnMubWF4Wm9vbSB8fCB6ID09PSBjeikgY29udGludWU7XG5cbiAgICAgICAgICAgIC8vIHN0b3AgdGlsaW5nIGlmIGl0J3Mgbm90IGFuIGFuY2VzdG9yIG9mIHRoZSB0YXJnZXQgdGlsZVxuICAgICAgICAgICAgdmFyIG0gPSAxIDw8IChjeiAtIHopO1xuICAgICAgICAgICAgaWYgKHggIT09IE1hdGguZmxvb3IoY3ggLyBtKSB8fCB5ICE9PSBNYXRoLmZsb29yKGN5IC8gbSkpIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gaWYgd2Ugc2xpY2UgZnVydGhlciBkb3duLCBubyBuZWVkIHRvIGtlZXAgc291cmNlIGdlb21ldHJ5XG4gICAgICAgIHRpbGUuc291cmNlID0gbnVsbDtcblxuICAgICAgICBpZiAoZmVhdHVyZXMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcblxuICAgICAgICBpZiAoZGVidWcgPiAxKSBjb25zb2xlLnRpbWUoJ2NsaXBwaW5nJyk7XG5cbiAgICAgICAgLy8gdmFsdWVzIHdlJ2xsIHVzZSBmb3IgY2xpcHBpbmdcbiAgICAgICAgdmFyIGsxID0gMC41ICogb3B0aW9ucy5idWZmZXIgLyBvcHRpb25zLmV4dGVudCxcbiAgICAgICAgICAgIGsyID0gMC41IC0gazEsXG4gICAgICAgICAgICBrMyA9IDAuNSArIGsxLFxuICAgICAgICAgICAgazQgPSAxICsgazEsXG4gICAgICAgICAgICB0bCwgYmwsIHRyLCBiciwgbGVmdCwgcmlnaHQ7XG5cbiAgICAgICAgdGwgPSBibCA9IHRyID0gYnIgPSBudWxsO1xuXG4gICAgICAgIGxlZnQgID0gY2xpcChmZWF0dXJlcywgejIsIHggLSBrMSwgeCArIGszLCAwLCB0aWxlLm1pblgsIHRpbGUubWF4WCwgb3B0aW9ucyk7XG4gICAgICAgIHJpZ2h0ID0gY2xpcChmZWF0dXJlcywgejIsIHggKyBrMiwgeCArIGs0LCAwLCB0aWxlLm1pblgsIHRpbGUubWF4WCwgb3B0aW9ucyk7XG4gICAgICAgIGZlYXR1cmVzID0gbnVsbDtcblxuICAgICAgICBpZiAobGVmdCkge1xuICAgICAgICAgICAgdGwgPSBjbGlwKGxlZnQsIHoyLCB5IC0gazEsIHkgKyBrMywgMSwgdGlsZS5taW5ZLCB0aWxlLm1heFksIG9wdGlvbnMpO1xuICAgICAgICAgICAgYmwgPSBjbGlwKGxlZnQsIHoyLCB5ICsgazIsIHkgKyBrNCwgMSwgdGlsZS5taW5ZLCB0aWxlLm1heFksIG9wdGlvbnMpO1xuICAgICAgICAgICAgbGVmdCA9IG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmlnaHQpIHtcbiAgICAgICAgICAgIHRyID0gY2xpcChyaWdodCwgejIsIHkgLSBrMSwgeSArIGszLCAxLCB0aWxlLm1pblksIHRpbGUubWF4WSwgb3B0aW9ucyk7XG4gICAgICAgICAgICBiciA9IGNsaXAocmlnaHQsIHoyLCB5ICsgazIsIHkgKyBrNCwgMSwgdGlsZS5taW5ZLCB0aWxlLm1heFksIG9wdGlvbnMpO1xuICAgICAgICAgICAgcmlnaHQgPSBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGRlYnVnID4gMSkgY29uc29sZS50aW1lRW5kKCdjbGlwcGluZycpO1xuXG4gICAgICAgIHN0YWNrLnB1c2godGwgfHwgW10sIHogKyAxLCB4ICogMiwgICAgIHkgKiAyKTtcbiAgICAgICAgc3RhY2sucHVzaChibCB8fCBbXSwgeiArIDEsIHggKiAyLCAgICAgeSAqIDIgKyAxKTtcbiAgICAgICAgc3RhY2sucHVzaCh0ciB8fCBbXSwgeiArIDEsIHggKiAyICsgMSwgeSAqIDIpO1xuICAgICAgICBzdGFjay5wdXNoKGJyIHx8IFtdLCB6ICsgMSwgeCAqIDIgKyAxLCB5ICogMiArIDEpO1xuICAgIH1cbn07XG5cbkdlb0pTT05WVC5wcm90b3R5cGUuZ2V0VGlsZSA9IGZ1bmN0aW9uICh6LCB4LCB5KSB7XG4gICAgdmFyIG9wdGlvbnMgPSB0aGlzLm9wdGlvbnMsXG4gICAgICAgIGV4dGVudCA9IG9wdGlvbnMuZXh0ZW50LFxuICAgICAgICBkZWJ1ZyA9IG9wdGlvbnMuZGVidWc7XG5cbiAgICBpZiAoeiA8IDAgfHwgeiA+IDI0KSByZXR1cm4gbnVsbDtcblxuICAgIHZhciB6MiA9IDEgPDwgejtcbiAgICB4ID0gKCh4ICUgejIpICsgejIpICUgejI7IC8vIHdyYXAgdGlsZSB4IGNvb3JkaW5hdGVcblxuICAgIHZhciBpZCA9IHRvSUQoeiwgeCwgeSk7XG4gICAgaWYgKHRoaXMudGlsZXNbaWRdKSByZXR1cm4gdHJhbnNmb3JtKHRoaXMudGlsZXNbaWRdLCBleHRlbnQpO1xuXG4gICAgaWYgKGRlYnVnID4gMSkgY29uc29sZS5sb2coJ2RyaWxsaW5nIGRvd24gdG8geiVkLSVkLSVkJywgeiwgeCwgeSk7XG5cbiAgICB2YXIgejAgPSB6LFxuICAgICAgICB4MCA9IHgsXG4gICAgICAgIHkwID0geSxcbiAgICAgICAgcGFyZW50O1xuXG4gICAgd2hpbGUgKCFwYXJlbnQgJiYgejAgPiAwKSB7XG4gICAgICAgIHowLS07XG4gICAgICAgIHgwID0gTWF0aC5mbG9vcih4MCAvIDIpO1xuICAgICAgICB5MCA9IE1hdGguZmxvb3IoeTAgLyAyKTtcbiAgICAgICAgcGFyZW50ID0gdGhpcy50aWxlc1t0b0lEKHowLCB4MCwgeTApXTtcbiAgICB9XG5cbiAgICBpZiAoIXBhcmVudCB8fCAhcGFyZW50LnNvdXJjZSkgcmV0dXJuIG51bGw7XG5cbiAgICAvLyBpZiB3ZSBmb3VuZCBhIHBhcmVudCB0aWxlIGNvbnRhaW5pbmcgdGhlIG9yaWdpbmFsIGdlb21ldHJ5LCB3ZSBjYW4gZHJpbGwgZG93biBmcm9tIGl0XG4gICAgaWYgKGRlYnVnID4gMSkgY29uc29sZS5sb2coJ2ZvdW5kIHBhcmVudCB0aWxlIHolZC0lZC0lZCcsIHowLCB4MCwgeTApO1xuXG4gICAgaWYgKGRlYnVnID4gMSkgY29uc29sZS50aW1lKCdkcmlsbGluZyBkb3duJyk7XG4gICAgdGhpcy5zcGxpdFRpbGUocGFyZW50LnNvdXJjZSwgejAsIHgwLCB5MCwgeiwgeCwgeSk7XG4gICAgaWYgKGRlYnVnID4gMSkgY29uc29sZS50aW1lRW5kKCdkcmlsbGluZyBkb3duJyk7XG5cbiAgICByZXR1cm4gdGhpcy50aWxlc1tpZF0gPyB0cmFuc2Zvcm0odGhpcy50aWxlc1tpZF0sIGV4dGVudCkgOiBudWxsO1xufTtcblxuZnVuY3Rpb24gdG9JRCh6LCB4LCB5KSB7XG4gICAgcmV0dXJuICgoKDEgPDwgeikgKiB5ICsgeCkgKiAzMikgKyB6O1xufVxuXG5mdW5jdGlvbiBleHRlbmQoZGVzdCwgc3JjKSB7XG4gICAgZm9yICh2YXIgaSBpbiBzcmMpIGRlc3RbaV0gPSBzcmNbaV07XG4gICAgcmV0dXJuIGRlc3Q7XG59XG4iLG51bGwsbnVsbCwidmFyIGNvbW1vbmpzR2xvYmFsID0gdHlwZW9mIGdsb2JhbFRoaXMgIT09ICd1bmRlZmluZWQnID8gZ2xvYmFsVGhpcyA6IHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnID8gd2luZG93IDogdHlwZW9mIGdsb2JhbCAhPT0gJ3VuZGVmaW5lZCcgPyBnbG9iYWwgOiB0eXBlb2Ygc2VsZiAhPT0gJ3VuZGVmaW5lZCcgPyBzZWxmIDoge307XG5cbnZhciBjaGVjayA9IGZ1bmN0aW9uIChpdCkge1xuICByZXR1cm4gaXQgJiYgaXQuTWF0aCA9PSBNYXRoICYmIGl0O1xufTtcblxuLy8gaHR0cHM6Ly9naXRodWIuY29tL3psb2lyb2NrL2NvcmUtanMvaXNzdWVzLzg2I2lzc3VlY29tbWVudC0xMTU3NTkwMjhcbnZhciBnbG9iYWwkZiA9XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBlcy14L25vLWdsb2JhbC10aGlzIC0tIHNhZmVcbiAgY2hlY2sodHlwZW9mIGdsb2JhbFRoaXMgPT0gJ29iamVjdCcgJiYgZ2xvYmFsVGhpcykgfHxcbiAgY2hlY2sodHlwZW9mIHdpbmRvdyA9PSAnb2JqZWN0JyAmJiB3aW5kb3cpIHx8XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1yZXN0cmljdGVkLWdsb2JhbHMgLS0gc2FmZVxuICBjaGVjayh0eXBlb2Ygc2VsZiA9PSAnb2JqZWN0JyAmJiBzZWxmKSB8fFxuICBjaGVjayh0eXBlb2YgY29tbW9uanNHbG9iYWwgPT0gJ29iamVjdCcgJiYgY29tbW9uanNHbG9iYWwpIHx8XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1uZXctZnVuYyAtLSBmYWxsYmFja1xuICAoZnVuY3Rpb24gKCkgeyByZXR1cm4gdGhpczsgfSkoKSB8fCBGdW5jdGlvbigncmV0dXJuIHRoaXMnKSgpO1xuXG52YXIgb2JqZWN0R2V0T3duUHJvcGVydHlEZXNjcmlwdG9yID0ge307XG5cbnZhciBmYWlscyRqID0gZnVuY3Rpb24gKGV4ZWMpIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gISFleGVjKCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn07XG5cbnZhciBmYWlscyRpID0gZmFpbHMkajtcblxuLy8gRGV0ZWN0IElFOCdzIGluY29tcGxldGUgZGVmaW5lUHJvcGVydHkgaW1wbGVtZW50YXRpb25cbnZhciBkZXNjcmlwdG9ycyA9ICFmYWlscyRpKGZ1bmN0aW9uICgpIHtcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tb2JqZWN0LWRlZmluZXByb3BlcnR5IC0tIHJlcXVpcmVkIGZvciB0ZXN0aW5nXG4gIHJldHVybiBPYmplY3QuZGVmaW5lUHJvcGVydHkoe30sIDEsIHsgZ2V0OiBmdW5jdGlvbiAoKSB7IHJldHVybiA3OyB9IH0pWzFdICE9IDc7XG59KTtcblxudmFyIGZhaWxzJGggPSBmYWlscyRqO1xuXG52YXIgZnVuY3Rpb25CaW5kTmF0aXZlID0gIWZhaWxzJGgoZnVuY3Rpb24gKCkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZXMteC9uby1mdW5jdGlvbi1wcm90b3R5cGUtYmluZCAtLSBzYWZlXG4gIHZhciB0ZXN0ID0gKGZ1bmN0aW9uICgpIHsgLyogZW1wdHkgKi8gfSkuYmluZCgpO1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tcHJvdG90eXBlLWJ1aWx0aW5zIC0tIHNhZmVcbiAgcmV0dXJuIHR5cGVvZiB0ZXN0ICE9ICdmdW5jdGlvbicgfHwgdGVzdC5oYXNPd25Qcm9wZXJ0eSgncHJvdG90eXBlJyk7XG59KTtcblxudmFyIE5BVElWRV9CSU5EJDIgPSBmdW5jdGlvbkJpbmROYXRpdmU7XG5cbnZhciBjYWxsJGIgPSBGdW5jdGlvbi5wcm90b3R5cGUuY2FsbDtcblxudmFyIGZ1bmN0aW9uQ2FsbCA9IE5BVElWRV9CSU5EJDIgPyBjYWxsJGIuYmluZChjYWxsJGIpIDogZnVuY3Rpb24gKCkge1xuICByZXR1cm4gY2FsbCRiLmFwcGx5KGNhbGwkYiwgYXJndW1lbnRzKTtcbn07XG5cbnZhciBvYmplY3RQcm9wZXJ0eUlzRW51bWVyYWJsZSA9IHt9O1xuXG52YXIgJHByb3BlcnR5SXNFbnVtZXJhYmxlID0ge30ucHJvcGVydHlJc0VudW1lcmFibGU7XG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZXMteC9uby1vYmplY3QtZ2V0b3ducHJvcGVydHlkZXNjcmlwdG9yIC0tIHNhZmVcbnZhciBnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IkMSA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3I7XG5cbi8vIE5hc2hvcm4gfiBKREs4IGJ1Z1xudmFyIE5BU0hPUk5fQlVHID0gZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yJDEgJiYgISRwcm9wZXJ0eUlzRW51bWVyYWJsZS5jYWxsKHsgMTogMiB9LCAxKTtcblxuLy8gYE9iamVjdC5wcm90b3R5cGUucHJvcGVydHlJc0VudW1lcmFibGVgIG1ldGhvZCBpbXBsZW1lbnRhdGlvblxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1vYmplY3QucHJvdG90eXBlLnByb3BlcnR5aXNlbnVtZXJhYmxlXG5vYmplY3RQcm9wZXJ0eUlzRW51bWVyYWJsZS5mID0gTkFTSE9STl9CVUcgPyBmdW5jdGlvbiBwcm9wZXJ0eUlzRW51bWVyYWJsZShWKSB7XG4gIHZhciBkZXNjcmlwdG9yID0gZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yJDEodGhpcywgVik7XG4gIHJldHVybiAhIWRlc2NyaXB0b3IgJiYgZGVzY3JpcHRvci5lbnVtZXJhYmxlO1xufSA6ICRwcm9wZXJ0eUlzRW51bWVyYWJsZTtcblxudmFyIGNyZWF0ZVByb3BlcnR5RGVzY3JpcHRvciQ0ID0gZnVuY3Rpb24gKGJpdG1hcCwgdmFsdWUpIHtcbiAgcmV0dXJuIHtcbiAgICBlbnVtZXJhYmxlOiAhKGJpdG1hcCAmIDEpLFxuICAgIGNvbmZpZ3VyYWJsZTogIShiaXRtYXAgJiAyKSxcbiAgICB3cml0YWJsZTogIShiaXRtYXAgJiA0KSxcbiAgICB2YWx1ZTogdmFsdWVcbiAgfTtcbn07XG5cbnZhciBOQVRJVkVfQklORCQxID0gZnVuY3Rpb25CaW5kTmF0aXZlO1xuXG52YXIgRnVuY3Rpb25Qcm90b3R5cGUkMiA9IEZ1bmN0aW9uLnByb3RvdHlwZTtcbnZhciBiaW5kID0gRnVuY3Rpb25Qcm90b3R5cGUkMi5iaW5kO1xudmFyIGNhbGwkYSA9IEZ1bmN0aW9uUHJvdG90eXBlJDIuY2FsbDtcbnZhciB1bmN1cnJ5VGhpcyRqID0gTkFUSVZFX0JJTkQkMSAmJiBiaW5kLmJpbmQoY2FsbCRhLCBjYWxsJGEpO1xuXG52YXIgZnVuY3Rpb25VbmN1cnJ5VGhpcyA9IE5BVElWRV9CSU5EJDEgPyBmdW5jdGlvbiAoZm4pIHtcbiAgcmV0dXJuIGZuICYmIHVuY3VycnlUaGlzJGooZm4pO1xufSA6IGZ1bmN0aW9uIChmbikge1xuICByZXR1cm4gZm4gJiYgZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBjYWxsJGEuYXBwbHkoZm4sIGFyZ3VtZW50cyk7XG4gIH07XG59O1xuXG52YXIgdW5jdXJyeVRoaXMkaSA9IGZ1bmN0aW9uVW5jdXJyeVRoaXM7XG5cbnZhciB0b1N0cmluZyQ5ID0gdW5jdXJyeVRoaXMkaSh7fS50b1N0cmluZyk7XG52YXIgc3RyaW5nU2xpY2UkNCA9IHVuY3VycnlUaGlzJGkoJycuc2xpY2UpO1xuXG52YXIgY2xhc3NvZlJhdyQxID0gZnVuY3Rpb24gKGl0KSB7XG4gIHJldHVybiBzdHJpbmdTbGljZSQ0KHRvU3RyaW5nJDkoaXQpLCA4LCAtMSk7XG59O1xuXG52YXIgdW5jdXJyeVRoaXMkaCA9IGZ1bmN0aW9uVW5jdXJyeVRoaXM7XG52YXIgZmFpbHMkZyA9IGZhaWxzJGo7XG52YXIgY2xhc3NvZiQ1ID0gY2xhc3NvZlJhdyQxO1xuXG52YXIgJE9iamVjdCQ0ID0gT2JqZWN0O1xudmFyIHNwbGl0ID0gdW5jdXJyeVRoaXMkaCgnJy5zcGxpdCk7XG5cbi8vIGZhbGxiYWNrIGZvciBub24tYXJyYXktbGlrZSBFUzMgYW5kIG5vbi1lbnVtZXJhYmxlIG9sZCBWOCBzdHJpbmdzXG52YXIgaW5kZXhlZE9iamVjdCA9IGZhaWxzJGcoZnVuY3Rpb24gKCkge1xuICAvLyB0aHJvd3MgYW4gZXJyb3IgaW4gcmhpbm8sIHNlZSBodHRwczovL2dpdGh1Yi5jb20vbW96aWxsYS9yaGluby9pc3N1ZXMvMzQ2XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1wcm90b3R5cGUtYnVpbHRpbnMgLS0gc2FmZVxuICByZXR1cm4gISRPYmplY3QkNCgneicpLnByb3BlcnR5SXNFbnVtZXJhYmxlKDApO1xufSkgPyBmdW5jdGlvbiAoaXQpIHtcbiAgcmV0dXJuIGNsYXNzb2YkNShpdCkgPT0gJ1N0cmluZycgPyBzcGxpdChpdCwgJycpIDogJE9iamVjdCQ0KGl0KTtcbn0gOiAkT2JqZWN0JDQ7XG5cbnZhciAkVHlwZUVycm9yJDggPSBUeXBlRXJyb3I7XG5cbi8vIGBSZXF1aXJlT2JqZWN0Q29lcmNpYmxlYCBhYnN0cmFjdCBvcGVyYXRpb25cbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtcmVxdWlyZW9iamVjdGNvZXJjaWJsZVxudmFyIHJlcXVpcmVPYmplY3RDb2VyY2libGUkNyA9IGZ1bmN0aW9uIChpdCkge1xuICBpZiAoaXQgPT0gdW5kZWZpbmVkKSB0aHJvdyAkVHlwZUVycm9yJDgoXCJDYW4ndCBjYWxsIG1ldGhvZCBvbiBcIiArIGl0KTtcbiAgcmV0dXJuIGl0O1xufTtcblxuLy8gdG9PYmplY3Qgd2l0aCBmYWxsYmFjayBmb3Igbm9uLWFycmF5LWxpa2UgRVMzIHN0cmluZ3NcbnZhciBJbmRleGVkT2JqZWN0JDEgPSBpbmRleGVkT2JqZWN0O1xudmFyIHJlcXVpcmVPYmplY3RDb2VyY2libGUkNiA9IHJlcXVpcmVPYmplY3RDb2VyY2libGUkNztcblxudmFyIHRvSW5kZXhlZE9iamVjdCQ1ID0gZnVuY3Rpb24gKGl0KSB7XG4gIHJldHVybiBJbmRleGVkT2JqZWN0JDEocmVxdWlyZU9iamVjdENvZXJjaWJsZSQ2KGl0KSk7XG59O1xuXG4vLyBgSXNDYWxsYWJsZWAgYWJzdHJhY3Qgb3BlcmF0aW9uXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLWlzY2FsbGFibGVcbnZhciBpc0NhbGxhYmxlJGggPSBmdW5jdGlvbiAoYXJndW1lbnQpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmd1bWVudCA9PSAnZnVuY3Rpb24nO1xufTtcblxudmFyIGlzQ2FsbGFibGUkZyA9IGlzQ2FsbGFibGUkaDtcblxudmFyIGlzT2JqZWN0JDYgPSBmdW5jdGlvbiAoaXQpIHtcbiAgcmV0dXJuIHR5cGVvZiBpdCA9PSAnb2JqZWN0JyA/IGl0ICE9PSBudWxsIDogaXNDYWxsYWJsZSRnKGl0KTtcbn07XG5cbnZhciBnbG9iYWwkZSA9IGdsb2JhbCRmO1xudmFyIGlzQ2FsbGFibGUkZiA9IGlzQ2FsbGFibGUkaDtcblxudmFyIGFGdW5jdGlvbiA9IGZ1bmN0aW9uIChhcmd1bWVudCkge1xuICByZXR1cm4gaXNDYWxsYWJsZSRmKGFyZ3VtZW50KSA/IGFyZ3VtZW50IDogdW5kZWZpbmVkO1xufTtcblxudmFyIGdldEJ1aWx0SW4kNSA9IGZ1bmN0aW9uIChuYW1lc3BhY2UsIG1ldGhvZCkge1xuICByZXR1cm4gYXJndW1lbnRzLmxlbmd0aCA8IDIgPyBhRnVuY3Rpb24oZ2xvYmFsJGVbbmFtZXNwYWNlXSkgOiBnbG9iYWwkZVtuYW1lc3BhY2VdICYmIGdsb2JhbCRlW25hbWVzcGFjZV1bbWV0aG9kXTtcbn07XG5cbnZhciB1bmN1cnJ5VGhpcyRnID0gZnVuY3Rpb25VbmN1cnJ5VGhpcztcblxudmFyIG9iamVjdElzUHJvdG90eXBlT2YgPSB1bmN1cnJ5VGhpcyRnKHt9LmlzUHJvdG90eXBlT2YpO1xuXG52YXIgZ2V0QnVpbHRJbiQ0ID0gZ2V0QnVpbHRJbiQ1O1xuXG52YXIgZW5naW5lVXNlckFnZW50ID0gZ2V0QnVpbHRJbiQ0KCduYXZpZ2F0b3InLCAndXNlckFnZW50JykgfHwgJyc7XG5cbnZhciBnbG9iYWwkZCA9IGdsb2JhbCRmO1xudmFyIHVzZXJBZ2VudCQxID0gZW5naW5lVXNlckFnZW50O1xuXG52YXIgcHJvY2VzcyA9IGdsb2JhbCRkLnByb2Nlc3M7XG52YXIgRGVubyA9IGdsb2JhbCRkLkRlbm87XG52YXIgdmVyc2lvbnMgPSBwcm9jZXNzICYmIHByb2Nlc3MudmVyc2lvbnMgfHwgRGVubyAmJiBEZW5vLnZlcnNpb247XG52YXIgdjggPSB2ZXJzaW9ucyAmJiB2ZXJzaW9ucy52ODtcbnZhciBtYXRjaCwgdmVyc2lvbjtcblxuaWYgKHY4KSB7XG4gIG1hdGNoID0gdjguc3BsaXQoJy4nKTtcbiAgLy8gaW4gb2xkIENocm9tZSwgdmVyc2lvbnMgb2YgVjggaXNuJ3QgVjggPSBDaHJvbWUgLyAxMFxuICAvLyBidXQgdGhlaXIgY29ycmVjdCB2ZXJzaW9ucyBhcmUgbm90IGludGVyZXN0aW5nIGZvciB1c1xuICB2ZXJzaW9uID0gbWF0Y2hbMF0gPiAwICYmIG1hdGNoWzBdIDwgNCA/IDEgOiArKG1hdGNoWzBdICsgbWF0Y2hbMV0pO1xufVxuXG4vLyBCcm93c2VyRlMgTm9kZUpTIGBwcm9jZXNzYCBwb2x5ZmlsbCBpbmNvcnJlY3RseSBzZXQgYC52OGAgdG8gYDAuMGBcbi8vIHNvIGNoZWNrIGB1c2VyQWdlbnRgIGV2ZW4gaWYgYC52OGAgZXhpc3RzLCBidXQgMFxuaWYgKCF2ZXJzaW9uICYmIHVzZXJBZ2VudCQxKSB7XG4gIG1hdGNoID0gdXNlckFnZW50JDEubWF0Y2goL0VkZ2VcXC8oXFxkKykvKTtcbiAgaWYgKCFtYXRjaCB8fCBtYXRjaFsxXSA+PSA3NCkge1xuICAgIG1hdGNoID0gdXNlckFnZW50JDEubWF0Y2goL0Nocm9tZVxcLyhcXGQrKS8pO1xuICAgIGlmIChtYXRjaCkgdmVyc2lvbiA9ICttYXRjaFsxXTtcbiAgfVxufVxuXG52YXIgZW5naW5lVjhWZXJzaW9uID0gdmVyc2lvbjtcblxuLyogZXNsaW50LWRpc2FibGUgZXMteC9uby1zeW1ib2wgLS0gcmVxdWlyZWQgZm9yIHRlc3RpbmcgKi9cblxudmFyIFY4X1ZFUlNJT04gPSBlbmdpbmVWOFZlcnNpb247XG52YXIgZmFpbHMkZiA9IGZhaWxzJGo7XG5cbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBlcy14L25vLW9iamVjdC1nZXRvd25wcm9wZXJ0eXN5bWJvbHMgLS0gcmVxdWlyZWQgZm9yIHRlc3RpbmdcbnZhciBuYXRpdmVTeW1ib2wgPSAhIU9iamVjdC5nZXRPd25Qcm9wZXJ0eVN5bWJvbHMgJiYgIWZhaWxzJGYoZnVuY3Rpb24gKCkge1xuICB2YXIgc3ltYm9sID0gU3ltYm9sKCk7XG4gIC8vIENocm9tZSAzOCBTeW1ib2wgaGFzIGluY29ycmVjdCB0b1N0cmluZyBjb252ZXJzaW9uXG4gIC8vIGBnZXQtb3duLXByb3BlcnR5LXN5bWJvbHNgIHBvbHlmaWxsIHN5bWJvbHMgY29udmVydGVkIHRvIG9iamVjdCBhcmUgbm90IFN5bWJvbCBpbnN0YW5jZXNcbiAgcmV0dXJuICFTdHJpbmcoc3ltYm9sKSB8fCAhKE9iamVjdChzeW1ib2wpIGluc3RhbmNlb2YgU3ltYm9sKSB8fFxuICAgIC8vIENocm9tZSAzOC00MCBzeW1ib2xzIGFyZSBub3QgaW5oZXJpdGVkIGZyb20gRE9NIGNvbGxlY3Rpb25zIHByb3RvdHlwZXMgdG8gaW5zdGFuY2VzXG4gICAgIVN5bWJvbC5zaGFtICYmIFY4X1ZFUlNJT04gJiYgVjhfVkVSU0lPTiA8IDQxO1xufSk7XG5cbi8qIGVzbGludC1kaXNhYmxlIGVzLXgvbm8tc3ltYm9sIC0tIHJlcXVpcmVkIGZvciB0ZXN0aW5nICovXG5cbnZhciBOQVRJVkVfU1lNQk9MJDEgPSBuYXRpdmVTeW1ib2w7XG5cbnZhciB1c2VTeW1ib2xBc1VpZCA9IE5BVElWRV9TWU1CT0wkMVxuICAmJiAhU3ltYm9sLnNoYW1cbiAgJiYgdHlwZW9mIFN5bWJvbC5pdGVyYXRvciA9PSAnc3ltYm9sJztcblxudmFyIGdldEJ1aWx0SW4kMyA9IGdldEJ1aWx0SW4kNTtcbnZhciBpc0NhbGxhYmxlJGUgPSBpc0NhbGxhYmxlJGg7XG52YXIgaXNQcm90b3R5cGVPZiQxID0gb2JqZWN0SXNQcm90b3R5cGVPZjtcbnZhciBVU0VfU1lNQk9MX0FTX1VJRCQxID0gdXNlU3ltYm9sQXNVaWQ7XG5cbnZhciAkT2JqZWN0JDMgPSBPYmplY3Q7XG5cbnZhciBpc1N5bWJvbCQyID0gVVNFX1NZTUJPTF9BU19VSUQkMSA/IGZ1bmN0aW9uIChpdCkge1xuICByZXR1cm4gdHlwZW9mIGl0ID09ICdzeW1ib2wnO1xufSA6IGZ1bmN0aW9uIChpdCkge1xuICB2YXIgJFN5bWJvbCA9IGdldEJ1aWx0SW4kMygnU3ltYm9sJyk7XG4gIHJldHVybiBpc0NhbGxhYmxlJGUoJFN5bWJvbCkgJiYgaXNQcm90b3R5cGVPZiQxKCRTeW1ib2wucHJvdG90eXBlLCAkT2JqZWN0JDMoaXQpKTtcbn07XG5cbnZhciAkU3RyaW5nJDMgPSBTdHJpbmc7XG5cbnZhciB0cnlUb1N0cmluZyQyID0gZnVuY3Rpb24gKGFyZ3VtZW50KSB7XG4gIHRyeSB7XG4gICAgcmV0dXJuICRTdHJpbmckMyhhcmd1bWVudCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuICdPYmplY3QnO1xuICB9XG59O1xuXG52YXIgaXNDYWxsYWJsZSRkID0gaXNDYWxsYWJsZSRoO1xudmFyIHRyeVRvU3RyaW5nJDEgPSB0cnlUb1N0cmluZyQyO1xuXG52YXIgJFR5cGVFcnJvciQ3ID0gVHlwZUVycm9yO1xuXG4vLyBgQXNzZXJ0OiBJc0NhbGxhYmxlKGFyZ3VtZW50KSBpcyB0cnVlYFxudmFyIGFDYWxsYWJsZSQxID0gZnVuY3Rpb24gKGFyZ3VtZW50KSB7XG4gIGlmIChpc0NhbGxhYmxlJGQoYXJndW1lbnQpKSByZXR1cm4gYXJndW1lbnQ7XG4gIHRocm93ICRUeXBlRXJyb3IkNyh0cnlUb1N0cmluZyQxKGFyZ3VtZW50KSArICcgaXMgbm90IGEgZnVuY3Rpb24nKTtcbn07XG5cbnZhciBhQ2FsbGFibGUgPSBhQ2FsbGFibGUkMTtcblxuLy8gYEdldE1ldGhvZGAgYWJzdHJhY3Qgb3BlcmF0aW9uXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLWdldG1ldGhvZFxudmFyIGdldE1ldGhvZCQyID0gZnVuY3Rpb24gKFYsIFApIHtcbiAgdmFyIGZ1bmMgPSBWW1BdO1xuICByZXR1cm4gZnVuYyA9PSBudWxsID8gdW5kZWZpbmVkIDogYUNhbGxhYmxlKGZ1bmMpO1xufTtcblxudmFyIGNhbGwkOSA9IGZ1bmN0aW9uQ2FsbDtcbnZhciBpc0NhbGxhYmxlJGMgPSBpc0NhbGxhYmxlJGg7XG52YXIgaXNPYmplY3QkNSA9IGlzT2JqZWN0JDY7XG5cbnZhciAkVHlwZUVycm9yJDYgPSBUeXBlRXJyb3I7XG5cbi8vIGBPcmRpbmFyeVRvUHJpbWl0aXZlYCBhYnN0cmFjdCBvcGVyYXRpb25cbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtb3JkaW5hcnl0b3ByaW1pdGl2ZVxudmFyIG9yZGluYXJ5VG9QcmltaXRpdmUkMSA9IGZ1bmN0aW9uIChpbnB1dCwgcHJlZikge1xuICB2YXIgZm4sIHZhbDtcbiAgaWYgKHByZWYgPT09ICdzdHJpbmcnICYmIGlzQ2FsbGFibGUkYyhmbiA9IGlucHV0LnRvU3RyaW5nKSAmJiAhaXNPYmplY3QkNSh2YWwgPSBjYWxsJDkoZm4sIGlucHV0KSkpIHJldHVybiB2YWw7XG4gIGlmIChpc0NhbGxhYmxlJGMoZm4gPSBpbnB1dC52YWx1ZU9mKSAmJiAhaXNPYmplY3QkNSh2YWwgPSBjYWxsJDkoZm4sIGlucHV0KSkpIHJldHVybiB2YWw7XG4gIGlmIChwcmVmICE9PSAnc3RyaW5nJyAmJiBpc0NhbGxhYmxlJGMoZm4gPSBpbnB1dC50b1N0cmluZykgJiYgIWlzT2JqZWN0JDUodmFsID0gY2FsbCQ5KGZuLCBpbnB1dCkpKSByZXR1cm4gdmFsO1xuICB0aHJvdyAkVHlwZUVycm9yJDYoXCJDYW4ndCBjb252ZXJ0IG9iamVjdCB0byBwcmltaXRpdmUgdmFsdWVcIik7XG59O1xuXG52YXIgc2hhcmVkJDQgPSB7ZXhwb3J0czoge319O1xuXG52YXIgZ2xvYmFsJGMgPSBnbG9iYWwkZjtcblxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tb2JqZWN0LWRlZmluZXByb3BlcnR5IC0tIHNhZmVcbnZhciBkZWZpbmVQcm9wZXJ0eSQ1ID0gT2JqZWN0LmRlZmluZVByb3BlcnR5O1xuXG52YXIgZGVmaW5lR2xvYmFsUHJvcGVydHkkMyA9IGZ1bmN0aW9uIChrZXksIHZhbHVlKSB7XG4gIHRyeSB7XG4gICAgZGVmaW5lUHJvcGVydHkkNShnbG9iYWwkYywga2V5LCB7IHZhbHVlOiB2YWx1ZSwgY29uZmlndXJhYmxlOiB0cnVlLCB3cml0YWJsZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBnbG9iYWwkY1trZXldID0gdmFsdWU7XG4gIH0gcmV0dXJuIHZhbHVlO1xufTtcblxudmFyIGdsb2JhbCRiID0gZ2xvYmFsJGY7XG52YXIgZGVmaW5lR2xvYmFsUHJvcGVydHkkMiA9IGRlZmluZUdsb2JhbFByb3BlcnR5JDM7XG5cbnZhciBTSEFSRUQgPSAnX19jb3JlLWpzX3NoYXJlZF9fJztcbnZhciBzdG9yZSQzID0gZ2xvYmFsJGJbU0hBUkVEXSB8fCBkZWZpbmVHbG9iYWxQcm9wZXJ0eSQyKFNIQVJFRCwge30pO1xuXG52YXIgc2hhcmVkU3RvcmUgPSBzdG9yZSQzO1xuXG52YXIgc3RvcmUkMiA9IHNoYXJlZFN0b3JlO1xuXG4oc2hhcmVkJDQuZXhwb3J0cyA9IGZ1bmN0aW9uIChrZXksIHZhbHVlKSB7XG4gIHJldHVybiBzdG9yZSQyW2tleV0gfHwgKHN0b3JlJDJba2V5XSA9IHZhbHVlICE9PSB1bmRlZmluZWQgPyB2YWx1ZSA6IHt9KTtcbn0pKCd2ZXJzaW9ucycsIFtdKS5wdXNoKHtcbiAgdmVyc2lvbjogJzMuMjQuMCcsXG4gIG1vZGU6ICdnbG9iYWwnLFxuICBjb3B5cmlnaHQ6ICfCqSAyMDE0LTIwMjIgRGVuaXMgUHVzaGthcmV2ICh6bG9pcm9jay5ydSknLFxuICBsaWNlbnNlOiAnaHR0cHM6Ly9naXRodWIuY29tL3psb2lyb2NrL2NvcmUtanMvYmxvYi92My4yNC4wL0xJQ0VOU0UnLFxuICBzb3VyY2U6ICdodHRwczovL2dpdGh1Yi5jb20vemxvaXJvY2svY29yZS1qcydcbn0pO1xuXG52YXIgcmVxdWlyZU9iamVjdENvZXJjaWJsZSQ1ID0gcmVxdWlyZU9iamVjdENvZXJjaWJsZSQ3O1xuXG52YXIgJE9iamVjdCQyID0gT2JqZWN0O1xuXG4vLyBgVG9PYmplY3RgIGFic3RyYWN0IG9wZXJhdGlvblxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy10b29iamVjdFxudmFyIHRvT2JqZWN0JDMgPSBmdW5jdGlvbiAoYXJndW1lbnQpIHtcbiAgcmV0dXJuICRPYmplY3QkMihyZXF1aXJlT2JqZWN0Q29lcmNpYmxlJDUoYXJndW1lbnQpKTtcbn07XG5cbnZhciB1bmN1cnJ5VGhpcyRmID0gZnVuY3Rpb25VbmN1cnJ5VGhpcztcbnZhciB0b09iamVjdCQyID0gdG9PYmplY3QkMztcblxudmFyIGhhc093blByb3BlcnR5ID0gdW5jdXJyeVRoaXMkZih7fS5oYXNPd25Qcm9wZXJ0eSk7XG5cbi8vIGBIYXNPd25Qcm9wZXJ0eWAgYWJzdHJhY3Qgb3BlcmF0aW9uXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLWhhc293bnByb3BlcnR5XG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZXMteC9uby1vYmplY3QtaGFzb3duIC0tIHNhZmVcbnZhciBoYXNPd25Qcm9wZXJ0eV8xID0gT2JqZWN0Lmhhc093biB8fCBmdW5jdGlvbiBoYXNPd24oaXQsIGtleSkge1xuICByZXR1cm4gaGFzT3duUHJvcGVydHkodG9PYmplY3QkMihpdCksIGtleSk7XG59O1xuXG52YXIgdW5jdXJyeVRoaXMkZSA9IGZ1bmN0aW9uVW5jdXJyeVRoaXM7XG5cbnZhciBpZCA9IDA7XG52YXIgcG9zdGZpeCA9IE1hdGgucmFuZG9tKCk7XG52YXIgdG9TdHJpbmckOCA9IHVuY3VycnlUaGlzJGUoMS4wLnRvU3RyaW5nKTtcblxudmFyIHVpZCQyID0gZnVuY3Rpb24gKGtleSkge1xuICByZXR1cm4gJ1N5bWJvbCgnICsgKGtleSA9PT0gdW5kZWZpbmVkID8gJycgOiBrZXkpICsgJylfJyArIHRvU3RyaW5nJDgoKytpZCArIHBvc3RmaXgsIDM2KTtcbn07XG5cbnZhciBnbG9iYWwkYSA9IGdsb2JhbCRmO1xudmFyIHNoYXJlZCQzID0gc2hhcmVkJDQuZXhwb3J0cztcbnZhciBoYXNPd24kOSA9IGhhc093blByb3BlcnR5XzE7XG52YXIgdWlkJDEgPSB1aWQkMjtcbnZhciBOQVRJVkVfU1lNQk9MID0gbmF0aXZlU3ltYm9sO1xudmFyIFVTRV9TWU1CT0xfQVNfVUlEID0gdXNlU3ltYm9sQXNVaWQ7XG5cbnZhciBXZWxsS25vd25TeW1ib2xzU3RvcmUgPSBzaGFyZWQkMygnd2tzJyk7XG52YXIgU3ltYm9sJDIgPSBnbG9iYWwkYS5TeW1ib2w7XG52YXIgc3ltYm9sRm9yID0gU3ltYm9sJDIgJiYgU3ltYm9sJDJbJ2ZvciddO1xudmFyIGNyZWF0ZVdlbGxLbm93blN5bWJvbCA9IFVTRV9TWU1CT0xfQVNfVUlEID8gU3ltYm9sJDIgOiBTeW1ib2wkMiAmJiBTeW1ib2wkMi53aXRob3V0U2V0dGVyIHx8IHVpZCQxO1xuXG52YXIgd2VsbEtub3duU3ltYm9sJGIgPSBmdW5jdGlvbiAobmFtZSkge1xuICBpZiAoIWhhc093biQ5KFdlbGxLbm93blN5bWJvbHNTdG9yZSwgbmFtZSkgfHwgIShOQVRJVkVfU1lNQk9MIHx8IHR5cGVvZiBXZWxsS25vd25TeW1ib2xzU3RvcmVbbmFtZV0gPT0gJ3N0cmluZycpKSB7XG4gICAgdmFyIGRlc2NyaXB0aW9uID0gJ1N5bWJvbC4nICsgbmFtZTtcbiAgICBpZiAoTkFUSVZFX1NZTUJPTCAmJiBoYXNPd24kOShTeW1ib2wkMiwgbmFtZSkpIHtcbiAgICAgIFdlbGxLbm93blN5bWJvbHNTdG9yZVtuYW1lXSA9IFN5bWJvbCQyW25hbWVdO1xuICAgIH0gZWxzZSBpZiAoVVNFX1NZTUJPTF9BU19VSUQgJiYgc3ltYm9sRm9yKSB7XG4gICAgICBXZWxsS25vd25TeW1ib2xzU3RvcmVbbmFtZV0gPSBzeW1ib2xGb3IoZGVzY3JpcHRpb24pO1xuICAgIH0gZWxzZSB7XG4gICAgICBXZWxsS25vd25TeW1ib2xzU3RvcmVbbmFtZV0gPSBjcmVhdGVXZWxsS25vd25TeW1ib2woZGVzY3JpcHRpb24pO1xuICAgIH1cbiAgfSByZXR1cm4gV2VsbEtub3duU3ltYm9sc1N0b3JlW25hbWVdO1xufTtcblxudmFyIGNhbGwkOCA9IGZ1bmN0aW9uQ2FsbDtcbnZhciBpc09iamVjdCQ0ID0gaXNPYmplY3QkNjtcbnZhciBpc1N5bWJvbCQxID0gaXNTeW1ib2wkMjtcbnZhciBnZXRNZXRob2QkMSA9IGdldE1ldGhvZCQyO1xudmFyIG9yZGluYXJ5VG9QcmltaXRpdmUgPSBvcmRpbmFyeVRvUHJpbWl0aXZlJDE7XG52YXIgd2VsbEtub3duU3ltYm9sJGEgPSB3ZWxsS25vd25TeW1ib2wkYjtcblxudmFyICRUeXBlRXJyb3IkNSA9IFR5cGVFcnJvcjtcbnZhciBUT19QUklNSVRJVkUgPSB3ZWxsS25vd25TeW1ib2wkYSgndG9QcmltaXRpdmUnKTtcblxuLy8gYFRvUHJpbWl0aXZlYCBhYnN0cmFjdCBvcGVyYXRpb25cbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtdG9wcmltaXRpdmVcbnZhciB0b1ByaW1pdGl2ZSQxID0gZnVuY3Rpb24gKGlucHV0LCBwcmVmKSB7XG4gIGlmICghaXNPYmplY3QkNChpbnB1dCkgfHwgaXNTeW1ib2wkMShpbnB1dCkpIHJldHVybiBpbnB1dDtcbiAgdmFyIGV4b3RpY1RvUHJpbSA9IGdldE1ldGhvZCQxKGlucHV0LCBUT19QUklNSVRJVkUpO1xuICB2YXIgcmVzdWx0O1xuICBpZiAoZXhvdGljVG9QcmltKSB7XG4gICAgaWYgKHByZWYgPT09IHVuZGVmaW5lZCkgcHJlZiA9ICdkZWZhdWx0JztcbiAgICByZXN1bHQgPSBjYWxsJDgoZXhvdGljVG9QcmltLCBpbnB1dCwgcHJlZik7XG4gICAgaWYgKCFpc09iamVjdCQ0KHJlc3VsdCkgfHwgaXNTeW1ib2wkMShyZXN1bHQpKSByZXR1cm4gcmVzdWx0O1xuICAgIHRocm93ICRUeXBlRXJyb3IkNShcIkNhbid0IGNvbnZlcnQgb2JqZWN0IHRvIHByaW1pdGl2ZSB2YWx1ZVwiKTtcbiAgfVxuICBpZiAocHJlZiA9PT0gdW5kZWZpbmVkKSBwcmVmID0gJ251bWJlcic7XG4gIHJldHVybiBvcmRpbmFyeVRvUHJpbWl0aXZlKGlucHV0LCBwcmVmKTtcbn07XG5cbnZhciB0b1ByaW1pdGl2ZSA9IHRvUHJpbWl0aXZlJDE7XG52YXIgaXNTeW1ib2wgPSBpc1N5bWJvbCQyO1xuXG4vLyBgVG9Qcm9wZXJ0eUtleWAgYWJzdHJhY3Qgb3BlcmF0aW9uXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLXRvcHJvcGVydHlrZXlcbnZhciB0b1Byb3BlcnR5S2V5JDMgPSBmdW5jdGlvbiAoYXJndW1lbnQpIHtcbiAgdmFyIGtleSA9IHRvUHJpbWl0aXZlKGFyZ3VtZW50LCAnc3RyaW5nJyk7XG4gIHJldHVybiBpc1N5bWJvbChrZXkpID8ga2V5IDoga2V5ICsgJyc7XG59O1xuXG52YXIgZ2xvYmFsJDkgPSBnbG9iYWwkZjtcbnZhciBpc09iamVjdCQzID0gaXNPYmplY3QkNjtcblxudmFyIGRvY3VtZW50JDEgPSBnbG9iYWwkOS5kb2N1bWVudDtcbi8vIHR5cGVvZiBkb2N1bWVudC5jcmVhdGVFbGVtZW50IGlzICdvYmplY3QnIGluIG9sZCBJRVxudmFyIEVYSVNUUyQxID0gaXNPYmplY3QkMyhkb2N1bWVudCQxKSAmJiBpc09iamVjdCQzKGRvY3VtZW50JDEuY3JlYXRlRWxlbWVudCk7XG5cbnZhciBkb2N1bWVudENyZWF0ZUVsZW1lbnQkMiA9IGZ1bmN0aW9uIChpdCkge1xuICByZXR1cm4gRVhJU1RTJDEgPyBkb2N1bWVudCQxLmNyZWF0ZUVsZW1lbnQoaXQpIDoge307XG59O1xuXG52YXIgREVTQ1JJUFRPUlMkOSA9IGRlc2NyaXB0b3JzO1xudmFyIGZhaWxzJGUgPSBmYWlscyRqO1xudmFyIGNyZWF0ZUVsZW1lbnQgPSBkb2N1bWVudENyZWF0ZUVsZW1lbnQkMjtcblxuLy8gVGhhbmtzIHRvIElFOCBmb3IgaXRzIGZ1bm55IGRlZmluZVByb3BlcnR5XG52YXIgaWU4RG9tRGVmaW5lID0gIURFU0NSSVBUT1JTJDkgJiYgIWZhaWxzJGUoZnVuY3Rpb24gKCkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZXMteC9uby1vYmplY3QtZGVmaW5lcHJvcGVydHkgLS0gcmVxdWlyZWQgZm9yIHRlc3RpbmdcbiAgcmV0dXJuIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShjcmVhdGVFbGVtZW50KCdkaXYnKSwgJ2EnLCB7XG4gICAgZ2V0OiBmdW5jdGlvbiAoKSB7IHJldHVybiA3OyB9XG4gIH0pLmEgIT0gNztcbn0pO1xuXG52YXIgREVTQ1JJUFRPUlMkOCA9IGRlc2NyaXB0b3JzO1xudmFyIGNhbGwkNyA9IGZ1bmN0aW9uQ2FsbDtcbnZhciBwcm9wZXJ0eUlzRW51bWVyYWJsZU1vZHVsZSQxID0gb2JqZWN0UHJvcGVydHlJc0VudW1lcmFibGU7XG52YXIgY3JlYXRlUHJvcGVydHlEZXNjcmlwdG9yJDMgPSBjcmVhdGVQcm9wZXJ0eURlc2NyaXB0b3IkNDtcbnZhciB0b0luZGV4ZWRPYmplY3QkNCA9IHRvSW5kZXhlZE9iamVjdCQ1O1xudmFyIHRvUHJvcGVydHlLZXkkMiA9IHRvUHJvcGVydHlLZXkkMztcbnZhciBoYXNPd24kOCA9IGhhc093blByb3BlcnR5XzE7XG52YXIgSUU4X0RPTV9ERUZJTkUkMSA9IGllOERvbURlZmluZTtcblxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tb2JqZWN0LWdldG93bnByb3BlcnR5ZGVzY3JpcHRvciAtLSBzYWZlXG52YXIgJGdldE93blByb3BlcnR5RGVzY3JpcHRvciQxID0gT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcjtcblxuLy8gYE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3JgIG1ldGhvZFxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1vYmplY3QuZ2V0b3ducHJvcGVydHlkZXNjcmlwdG9yXG5vYmplY3RHZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IuZiA9IERFU0NSSVBUT1JTJDggPyAkZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yJDEgOiBmdW5jdGlvbiBnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoTywgUCkge1xuICBPID0gdG9JbmRleGVkT2JqZWN0JDQoTyk7XG4gIFAgPSB0b1Byb3BlcnR5S2V5JDIoUCk7XG4gIGlmIChJRThfRE9NX0RFRklORSQxKSB0cnkge1xuICAgIHJldHVybiAkZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yJDEoTywgUCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7IC8qIGVtcHR5ICovIH1cbiAgaWYgKGhhc093biQ4KE8sIFApKSByZXR1cm4gY3JlYXRlUHJvcGVydHlEZXNjcmlwdG9yJDMoIWNhbGwkNyhwcm9wZXJ0eUlzRW51bWVyYWJsZU1vZHVsZSQxLmYsIE8sIFApLCBPW1BdKTtcbn07XG5cbnZhciBvYmplY3REZWZpbmVQcm9wZXJ0eSA9IHt9O1xuXG52YXIgREVTQ1JJUFRPUlMkNyA9IGRlc2NyaXB0b3JzO1xudmFyIGZhaWxzJGQgPSBmYWlscyRqO1xuXG4vLyBWOCB+IENocm9tZSAzNi1cbi8vIGh0dHBzOi8vYnVncy5jaHJvbWl1bS5vcmcvcC92OC9pc3N1ZXMvZGV0YWlsP2lkPTMzMzRcbnZhciB2OFByb3RvdHlwZURlZmluZUJ1ZyA9IERFU0NSSVBUT1JTJDcgJiYgZmFpbHMkZChmdW5jdGlvbiAoKSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBlcy14L25vLW9iamVjdC1kZWZpbmVwcm9wZXJ0eSAtLSByZXF1aXJlZCBmb3IgdGVzdGluZ1xuICByZXR1cm4gT2JqZWN0LmRlZmluZVByb3BlcnR5KGZ1bmN0aW9uICgpIHsgLyogZW1wdHkgKi8gfSwgJ3Byb3RvdHlwZScsIHtcbiAgICB2YWx1ZTogNDIsXG4gICAgd3JpdGFibGU6IGZhbHNlXG4gIH0pLnByb3RvdHlwZSAhPSA0Mjtcbn0pO1xuXG52YXIgaXNPYmplY3QkMiA9IGlzT2JqZWN0JDY7XG5cbnZhciAkU3RyaW5nJDIgPSBTdHJpbmc7XG52YXIgJFR5cGVFcnJvciQ0ID0gVHlwZUVycm9yO1xuXG4vLyBgQXNzZXJ0OiBUeXBlKGFyZ3VtZW50KSBpcyBPYmplY3RgXG52YXIgYW5PYmplY3QkYSA9IGZ1bmN0aW9uIChhcmd1bWVudCkge1xuICBpZiAoaXNPYmplY3QkMihhcmd1bWVudCkpIHJldHVybiBhcmd1bWVudDtcbiAgdGhyb3cgJFR5cGVFcnJvciQ0KCRTdHJpbmckMihhcmd1bWVudCkgKyAnIGlzIG5vdCBhbiBvYmplY3QnKTtcbn07XG5cbnZhciBERVNDUklQVE9SUyQ2ID0gZGVzY3JpcHRvcnM7XG52YXIgSUU4X0RPTV9ERUZJTkUgPSBpZThEb21EZWZpbmU7XG52YXIgVjhfUFJPVE9UWVBFX0RFRklORV9CVUckMSA9IHY4UHJvdG90eXBlRGVmaW5lQnVnO1xudmFyIGFuT2JqZWN0JDkgPSBhbk9iamVjdCRhO1xudmFyIHRvUHJvcGVydHlLZXkkMSA9IHRvUHJvcGVydHlLZXkkMztcblxudmFyICRUeXBlRXJyb3IkMyA9IFR5cGVFcnJvcjtcbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBlcy14L25vLW9iamVjdC1kZWZpbmVwcm9wZXJ0eSAtLSBzYWZlXG52YXIgJGRlZmluZVByb3BlcnR5ID0gT2JqZWN0LmRlZmluZVByb3BlcnR5O1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tb2JqZWN0LWdldG93bnByb3BlcnR5ZGVzY3JpcHRvciAtLSBzYWZlXG52YXIgJGdldE93blByb3BlcnR5RGVzY3JpcHRvciA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3I7XG52YXIgRU5VTUVSQUJMRSA9ICdlbnVtZXJhYmxlJztcbnZhciBDT05GSUdVUkFCTEUkMSA9ICdjb25maWd1cmFibGUnO1xudmFyIFdSSVRBQkxFID0gJ3dyaXRhYmxlJztcblxuLy8gYE9iamVjdC5kZWZpbmVQcm9wZXJ0eWAgbWV0aG9kXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLW9iamVjdC5kZWZpbmVwcm9wZXJ0eVxub2JqZWN0RGVmaW5lUHJvcGVydHkuZiA9IERFU0NSSVBUT1JTJDYgPyBWOF9QUk9UT1RZUEVfREVGSU5FX0JVRyQxID8gZnVuY3Rpb24gZGVmaW5lUHJvcGVydHkoTywgUCwgQXR0cmlidXRlcykge1xuICBhbk9iamVjdCQ5KE8pO1xuICBQID0gdG9Qcm9wZXJ0eUtleSQxKFApO1xuICBhbk9iamVjdCQ5KEF0dHJpYnV0ZXMpO1xuICBpZiAodHlwZW9mIE8gPT09ICdmdW5jdGlvbicgJiYgUCA9PT0gJ3Byb3RvdHlwZScgJiYgJ3ZhbHVlJyBpbiBBdHRyaWJ1dGVzICYmIFdSSVRBQkxFIGluIEF0dHJpYnV0ZXMgJiYgIUF0dHJpYnV0ZXNbV1JJVEFCTEVdKSB7XG4gICAgdmFyIGN1cnJlbnQgPSAkZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKE8sIFApO1xuICAgIGlmIChjdXJyZW50ICYmIGN1cnJlbnRbV1JJVEFCTEVdKSB7XG4gICAgICBPW1BdID0gQXR0cmlidXRlcy52YWx1ZTtcbiAgICAgIEF0dHJpYnV0ZXMgPSB7XG4gICAgICAgIGNvbmZpZ3VyYWJsZTogQ09ORklHVVJBQkxFJDEgaW4gQXR0cmlidXRlcyA/IEF0dHJpYnV0ZXNbQ09ORklHVVJBQkxFJDFdIDogY3VycmVudFtDT05GSUdVUkFCTEUkMV0sXG4gICAgICAgIGVudW1lcmFibGU6IEVOVU1FUkFCTEUgaW4gQXR0cmlidXRlcyA/IEF0dHJpYnV0ZXNbRU5VTUVSQUJMRV0gOiBjdXJyZW50W0VOVU1FUkFCTEVdLFxuICAgICAgICB3cml0YWJsZTogZmFsc2VcbiAgICAgIH07XG4gICAgfVxuICB9IHJldHVybiAkZGVmaW5lUHJvcGVydHkoTywgUCwgQXR0cmlidXRlcyk7XG59IDogJGRlZmluZVByb3BlcnR5IDogZnVuY3Rpb24gZGVmaW5lUHJvcGVydHkoTywgUCwgQXR0cmlidXRlcykge1xuICBhbk9iamVjdCQ5KE8pO1xuICBQID0gdG9Qcm9wZXJ0eUtleSQxKFApO1xuICBhbk9iamVjdCQ5KEF0dHJpYnV0ZXMpO1xuICBpZiAoSUU4X0RPTV9ERUZJTkUpIHRyeSB7XG4gICAgcmV0dXJuICRkZWZpbmVQcm9wZXJ0eShPLCBQLCBBdHRyaWJ1dGVzKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHsgLyogZW1wdHkgKi8gfVxuICBpZiAoJ2dldCcgaW4gQXR0cmlidXRlcyB8fCAnc2V0JyBpbiBBdHRyaWJ1dGVzKSB0aHJvdyAkVHlwZUVycm9yJDMoJ0FjY2Vzc29ycyBub3Qgc3VwcG9ydGVkJyk7XG4gIGlmICgndmFsdWUnIGluIEF0dHJpYnV0ZXMpIE9bUF0gPSBBdHRyaWJ1dGVzLnZhbHVlO1xuICByZXR1cm4gTztcbn07XG5cbnZhciBERVNDUklQVE9SUyQ1ID0gZGVzY3JpcHRvcnM7XG52YXIgZGVmaW5lUHJvcGVydHlNb2R1bGUkNCA9IG9iamVjdERlZmluZVByb3BlcnR5O1xudmFyIGNyZWF0ZVByb3BlcnR5RGVzY3JpcHRvciQyID0gY3JlYXRlUHJvcGVydHlEZXNjcmlwdG9yJDQ7XG5cbnZhciBjcmVhdGVOb25FbnVtZXJhYmxlUHJvcGVydHkkNSA9IERFU0NSSVBUT1JTJDUgPyBmdW5jdGlvbiAob2JqZWN0LCBrZXksIHZhbHVlKSB7XG4gIHJldHVybiBkZWZpbmVQcm9wZXJ0eU1vZHVsZSQ0LmYob2JqZWN0LCBrZXksIGNyZWF0ZVByb3BlcnR5RGVzY3JpcHRvciQyKDEsIHZhbHVlKSk7XG59IDogZnVuY3Rpb24gKG9iamVjdCwga2V5LCB2YWx1ZSkge1xuICBvYmplY3Rba2V5XSA9IHZhbHVlO1xuICByZXR1cm4gb2JqZWN0O1xufTtcblxudmFyIG1ha2VCdWlsdEluJDIgPSB7ZXhwb3J0czoge319O1xuXG52YXIgREVTQ1JJUFRPUlMkNCA9IGRlc2NyaXB0b3JzO1xudmFyIGhhc093biQ3ID0gaGFzT3duUHJvcGVydHlfMTtcblxudmFyIEZ1bmN0aW9uUHJvdG90eXBlJDEgPSBGdW5jdGlvbi5wcm90b3R5cGU7XG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZXMteC9uby1vYmplY3QtZ2V0b3ducHJvcGVydHlkZXNjcmlwdG9yIC0tIHNhZmVcbnZhciBnZXREZXNjcmlwdG9yID0gREVTQ1JJUFRPUlMkNCAmJiBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yO1xuXG52YXIgRVhJU1RTID0gaGFzT3duJDcoRnVuY3Rpb25Qcm90b3R5cGUkMSwgJ25hbWUnKTtcbi8vIGFkZGl0aW9uYWwgcHJvdGVjdGlvbiBmcm9tIG1pbmlmaWVkIC8gbWFuZ2xlZCAvIGRyb3BwZWQgZnVuY3Rpb24gbmFtZXNcbnZhciBQUk9QRVIgPSBFWElTVFMgJiYgKGZ1bmN0aW9uIHNvbWV0aGluZygpIHsgLyogZW1wdHkgKi8gfSkubmFtZSA9PT0gJ3NvbWV0aGluZyc7XG52YXIgQ09ORklHVVJBQkxFID0gRVhJU1RTICYmICghREVTQ1JJUFRPUlMkNCB8fCAoREVTQ1JJUFRPUlMkNCAmJiBnZXREZXNjcmlwdG9yKEZ1bmN0aW9uUHJvdG90eXBlJDEsICduYW1lJykuY29uZmlndXJhYmxlKSk7XG5cbnZhciBmdW5jdGlvbk5hbWUgPSB7XG4gIEVYSVNUUzogRVhJU1RTLFxuICBQUk9QRVI6IFBST1BFUixcbiAgQ09ORklHVVJBQkxFOiBDT05GSUdVUkFCTEVcbn07XG5cbnZhciB1bmN1cnJ5VGhpcyRkID0gZnVuY3Rpb25VbmN1cnJ5VGhpcztcbnZhciBpc0NhbGxhYmxlJGIgPSBpc0NhbGxhYmxlJGg7XG52YXIgc3RvcmUkMSA9IHNoYXJlZFN0b3JlO1xuXG52YXIgZnVuY3Rpb25Ub1N0cmluZyA9IHVuY3VycnlUaGlzJGQoRnVuY3Rpb24udG9TdHJpbmcpO1xuXG4vLyB0aGlzIGhlbHBlciBicm9rZW4gaW4gYGNvcmUtanNAMy40LjEtMy40LjRgLCBzbyB3ZSBjYW4ndCB1c2UgYHNoYXJlZGAgaGVscGVyXG5pZiAoIWlzQ2FsbGFibGUkYihzdG9yZSQxLmluc3BlY3RTb3VyY2UpKSB7XG4gIHN0b3JlJDEuaW5zcGVjdFNvdXJjZSA9IGZ1bmN0aW9uIChpdCkge1xuICAgIHJldHVybiBmdW5jdGlvblRvU3RyaW5nKGl0KTtcbiAgfTtcbn1cblxudmFyIGluc3BlY3RTb3VyY2UkMyA9IHN0b3JlJDEuaW5zcGVjdFNvdXJjZTtcblxudmFyIGdsb2JhbCQ4ID0gZ2xvYmFsJGY7XG52YXIgaXNDYWxsYWJsZSRhID0gaXNDYWxsYWJsZSRoO1xudmFyIGluc3BlY3RTb3VyY2UkMiA9IGluc3BlY3RTb3VyY2UkMztcblxudmFyIFdlYWtNYXAkMSA9IGdsb2JhbCQ4LldlYWtNYXA7XG5cbnZhciBuYXRpdmVXZWFrTWFwID0gaXNDYWxsYWJsZSRhKFdlYWtNYXAkMSkgJiYgL25hdGl2ZSBjb2RlLy50ZXN0KGluc3BlY3RTb3VyY2UkMihXZWFrTWFwJDEpKTtcblxudmFyIHNoYXJlZCQyID0gc2hhcmVkJDQuZXhwb3J0cztcbnZhciB1aWQgPSB1aWQkMjtcblxudmFyIGtleXMgPSBzaGFyZWQkMigna2V5cycpO1xuXG52YXIgc2hhcmVkS2V5JDMgPSBmdW5jdGlvbiAoa2V5KSB7XG4gIHJldHVybiBrZXlzW2tleV0gfHwgKGtleXNba2V5XSA9IHVpZChrZXkpKTtcbn07XG5cbnZhciBoaWRkZW5LZXlzJDQgPSB7fTtcblxudmFyIE5BVElWRV9XRUFLX01BUCA9IG5hdGl2ZVdlYWtNYXA7XG52YXIgZ2xvYmFsJDcgPSBnbG9iYWwkZjtcbnZhciB1bmN1cnJ5VGhpcyRjID0gZnVuY3Rpb25VbmN1cnJ5VGhpcztcbnZhciBpc09iamVjdCQxID0gaXNPYmplY3QkNjtcbnZhciBjcmVhdGVOb25FbnVtZXJhYmxlUHJvcGVydHkkNCA9IGNyZWF0ZU5vbkVudW1lcmFibGVQcm9wZXJ0eSQ1O1xudmFyIGhhc093biQ2ID0gaGFzT3duUHJvcGVydHlfMTtcbnZhciBzaGFyZWQkMSA9IHNoYXJlZFN0b3JlO1xudmFyIHNoYXJlZEtleSQyID0gc2hhcmVkS2V5JDM7XG52YXIgaGlkZGVuS2V5cyQzID0gaGlkZGVuS2V5cyQ0O1xuXG52YXIgT0JKRUNUX0FMUkVBRFlfSU5JVElBTElaRUQgPSAnT2JqZWN0IGFscmVhZHkgaW5pdGlhbGl6ZWQnO1xudmFyIFR5cGVFcnJvciQxID0gZ2xvYmFsJDcuVHlwZUVycm9yO1xudmFyIFdlYWtNYXAgPSBnbG9iYWwkNy5XZWFrTWFwO1xudmFyIHNldCwgZ2V0LCBoYXM7XG5cbnZhciBlbmZvcmNlID0gZnVuY3Rpb24gKGl0KSB7XG4gIHJldHVybiBoYXMoaXQpID8gZ2V0KGl0KSA6IHNldChpdCwge30pO1xufTtcblxudmFyIGdldHRlckZvciA9IGZ1bmN0aW9uIChUWVBFKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoaXQpIHtcbiAgICB2YXIgc3RhdGU7XG4gICAgaWYgKCFpc09iamVjdCQxKGl0KSB8fCAoc3RhdGUgPSBnZXQoaXQpKS50eXBlICE9PSBUWVBFKSB7XG4gICAgICB0aHJvdyBUeXBlRXJyb3IkMSgnSW5jb21wYXRpYmxlIHJlY2VpdmVyLCAnICsgVFlQRSArICcgcmVxdWlyZWQnKTtcbiAgICB9IHJldHVybiBzdGF0ZTtcbiAgfTtcbn07XG5cbmlmIChOQVRJVkVfV0VBS19NQVAgfHwgc2hhcmVkJDEuc3RhdGUpIHtcbiAgdmFyIHN0b3JlID0gc2hhcmVkJDEuc3RhdGUgfHwgKHNoYXJlZCQxLnN0YXRlID0gbmV3IFdlYWtNYXAoKSk7XG4gIHZhciB3bWdldCA9IHVuY3VycnlUaGlzJGMoc3RvcmUuZ2V0KTtcbiAgdmFyIHdtaGFzID0gdW5jdXJyeVRoaXMkYyhzdG9yZS5oYXMpO1xuICB2YXIgd21zZXQgPSB1bmN1cnJ5VGhpcyRjKHN0b3JlLnNldCk7XG4gIHNldCA9IGZ1bmN0aW9uIChpdCwgbWV0YWRhdGEpIHtcbiAgICBpZiAod21oYXMoc3RvcmUsIGl0KSkgdGhyb3cgbmV3IFR5cGVFcnJvciQxKE9CSkVDVF9BTFJFQURZX0lOSVRJQUxJWkVEKTtcbiAgICBtZXRhZGF0YS5mYWNhZGUgPSBpdDtcbiAgICB3bXNldChzdG9yZSwgaXQsIG1ldGFkYXRhKTtcbiAgICByZXR1cm4gbWV0YWRhdGE7XG4gIH07XG4gIGdldCA9IGZ1bmN0aW9uIChpdCkge1xuICAgIHJldHVybiB3bWdldChzdG9yZSwgaXQpIHx8IHt9O1xuICB9O1xuICBoYXMgPSBmdW5jdGlvbiAoaXQpIHtcbiAgICByZXR1cm4gd21oYXMoc3RvcmUsIGl0KTtcbiAgfTtcbn0gZWxzZSB7XG4gIHZhciBTVEFURSA9IHNoYXJlZEtleSQyKCdzdGF0ZScpO1xuICBoaWRkZW5LZXlzJDNbU1RBVEVdID0gdHJ1ZTtcbiAgc2V0ID0gZnVuY3Rpb24gKGl0LCBtZXRhZGF0YSkge1xuICAgIGlmIChoYXNPd24kNihpdCwgU1RBVEUpKSB0aHJvdyBuZXcgVHlwZUVycm9yJDEoT0JKRUNUX0FMUkVBRFlfSU5JVElBTElaRUQpO1xuICAgIG1ldGFkYXRhLmZhY2FkZSA9IGl0O1xuICAgIGNyZWF0ZU5vbkVudW1lcmFibGVQcm9wZXJ0eSQ0KGl0LCBTVEFURSwgbWV0YWRhdGEpO1xuICAgIHJldHVybiBtZXRhZGF0YTtcbiAgfTtcbiAgZ2V0ID0gZnVuY3Rpb24gKGl0KSB7XG4gICAgcmV0dXJuIGhhc093biQ2KGl0LCBTVEFURSkgPyBpdFtTVEFURV0gOiB7fTtcbiAgfTtcbiAgaGFzID0gZnVuY3Rpb24gKGl0KSB7XG4gICAgcmV0dXJuIGhhc093biQ2KGl0LCBTVEFURSk7XG4gIH07XG59XG5cbnZhciBpbnRlcm5hbFN0YXRlID0ge1xuICBzZXQ6IHNldCxcbiAgZ2V0OiBnZXQsXG4gIGhhczogaGFzLFxuICBlbmZvcmNlOiBlbmZvcmNlLFxuICBnZXR0ZXJGb3I6IGdldHRlckZvclxufTtcblxudmFyIGZhaWxzJGMgPSBmYWlscyRqO1xudmFyIGlzQ2FsbGFibGUkOSA9IGlzQ2FsbGFibGUkaDtcbnZhciBoYXNPd24kNSA9IGhhc093blByb3BlcnR5XzE7XG52YXIgREVTQ1JJUFRPUlMkMyA9IGRlc2NyaXB0b3JzO1xudmFyIENPTkZJR1VSQUJMRV9GVU5DVElPTl9OQU1FJDEgPSBmdW5jdGlvbk5hbWUuQ09ORklHVVJBQkxFO1xudmFyIGluc3BlY3RTb3VyY2UkMSA9IGluc3BlY3RTb3VyY2UkMztcbnZhciBJbnRlcm5hbFN0YXRlTW9kdWxlJDEgPSBpbnRlcm5hbFN0YXRlO1xuXG52YXIgZW5mb3JjZUludGVybmFsU3RhdGUgPSBJbnRlcm5hbFN0YXRlTW9kdWxlJDEuZW5mb3JjZTtcbnZhciBnZXRJbnRlcm5hbFN0YXRlJDIgPSBJbnRlcm5hbFN0YXRlTW9kdWxlJDEuZ2V0O1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tb2JqZWN0LWRlZmluZXByb3BlcnR5IC0tIHNhZmVcbnZhciBkZWZpbmVQcm9wZXJ0eSQ0ID0gT2JqZWN0LmRlZmluZVByb3BlcnR5O1xuXG52YXIgQ09ORklHVVJBQkxFX0xFTkdUSCA9IERFU0NSSVBUT1JTJDMgJiYgIWZhaWxzJGMoZnVuY3Rpb24gKCkge1xuICByZXR1cm4gZGVmaW5lUHJvcGVydHkkNChmdW5jdGlvbiAoKSB7IC8qIGVtcHR5ICovIH0sICdsZW5ndGgnLCB7IHZhbHVlOiA4IH0pLmxlbmd0aCAhPT0gODtcbn0pO1xuXG52YXIgVEVNUExBVEUgPSBTdHJpbmcoU3RyaW5nKS5zcGxpdCgnU3RyaW5nJyk7XG5cbnZhciBtYWtlQnVpbHRJbiQxID0gbWFrZUJ1aWx0SW4kMi5leHBvcnRzID0gZnVuY3Rpb24gKHZhbHVlLCBuYW1lLCBvcHRpb25zKSB7XG4gIGlmIChTdHJpbmcobmFtZSkuc2xpY2UoMCwgNykgPT09ICdTeW1ib2woJykge1xuICAgIG5hbWUgPSAnWycgKyBTdHJpbmcobmFtZSkucmVwbGFjZSgvXlN5bWJvbFxcKChbXildKilcXCkvLCAnJDEnKSArICddJztcbiAgfVxuICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmdldHRlcikgbmFtZSA9ICdnZXQgJyArIG5hbWU7XG4gIGlmIChvcHRpb25zICYmIG9wdGlvbnMuc2V0dGVyKSBuYW1lID0gJ3NldCAnICsgbmFtZTtcbiAgaWYgKCFoYXNPd24kNSh2YWx1ZSwgJ25hbWUnKSB8fCAoQ09ORklHVVJBQkxFX0ZVTkNUSU9OX05BTUUkMSAmJiB2YWx1ZS5uYW1lICE9PSBuYW1lKSkge1xuICAgIGlmIChERVNDUklQVE9SUyQzKSBkZWZpbmVQcm9wZXJ0eSQ0KHZhbHVlLCAnbmFtZScsIHsgdmFsdWU6IG5hbWUsIGNvbmZpZ3VyYWJsZTogdHJ1ZSB9KTtcbiAgICBlbHNlIHZhbHVlLm5hbWUgPSBuYW1lO1xuICB9XG4gIGlmIChDT05GSUdVUkFCTEVfTEVOR1RIICYmIG9wdGlvbnMgJiYgaGFzT3duJDUob3B0aW9ucywgJ2FyaXR5JykgJiYgdmFsdWUubGVuZ3RoICE9PSBvcHRpb25zLmFyaXR5KSB7XG4gICAgZGVmaW5lUHJvcGVydHkkNCh2YWx1ZSwgJ2xlbmd0aCcsIHsgdmFsdWU6IG9wdGlvbnMuYXJpdHkgfSk7XG4gIH1cbiAgdHJ5IHtcbiAgICBpZiAob3B0aW9ucyAmJiBoYXNPd24kNShvcHRpb25zLCAnY29uc3RydWN0b3InKSAmJiBvcHRpb25zLmNvbnN0cnVjdG9yKSB7XG4gICAgICBpZiAoREVTQ1JJUFRPUlMkMykgZGVmaW5lUHJvcGVydHkkNCh2YWx1ZSwgJ3Byb3RvdHlwZScsIHsgd3JpdGFibGU6IGZhbHNlIH0pO1xuICAgIC8vIGluIFY4IH4gQ2hyb21lIDUzLCBwcm90b3R5cGVzIG9mIHNvbWUgbWV0aG9kcywgbGlrZSBgQXJyYXkucHJvdG90eXBlLnZhbHVlc2AsIGFyZSBub24td3JpdGFibGVcbiAgICB9IGVsc2UgaWYgKHZhbHVlLnByb3RvdHlwZSkgdmFsdWUucHJvdG90eXBlID0gdW5kZWZpbmVkO1xuICB9IGNhdGNoIChlcnJvcikgeyAvKiBlbXB0eSAqLyB9XG4gIHZhciBzdGF0ZSA9IGVuZm9yY2VJbnRlcm5hbFN0YXRlKHZhbHVlKTtcbiAgaWYgKCFoYXNPd24kNShzdGF0ZSwgJ3NvdXJjZScpKSB7XG4gICAgc3RhdGUuc291cmNlID0gVEVNUExBVEUuam9pbih0eXBlb2YgbmFtZSA9PSAnc3RyaW5nJyA/IG5hbWUgOiAnJyk7XG4gIH0gcmV0dXJuIHZhbHVlO1xufTtcblxuLy8gYWRkIGZha2UgRnVuY3Rpb24jdG9TdHJpbmcgZm9yIGNvcnJlY3Qgd29yayB3cmFwcGVkIG1ldGhvZHMgLyBjb25zdHJ1Y3RvcnMgd2l0aCBtZXRob2RzIGxpa2UgTG9EYXNoIGlzTmF0aXZlXG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tZXh0ZW5kLW5hdGl2ZSAtLSByZXF1aXJlZFxuRnVuY3Rpb24ucHJvdG90eXBlLnRvU3RyaW5nID0gbWFrZUJ1aWx0SW4kMShmdW5jdGlvbiB0b1N0cmluZygpIHtcbiAgcmV0dXJuIGlzQ2FsbGFibGUkOSh0aGlzKSAmJiBnZXRJbnRlcm5hbFN0YXRlJDIodGhpcykuc291cmNlIHx8IGluc3BlY3RTb3VyY2UkMSh0aGlzKTtcbn0sICd0b1N0cmluZycpO1xuXG52YXIgaXNDYWxsYWJsZSQ4ID0gaXNDYWxsYWJsZSRoO1xudmFyIGRlZmluZVByb3BlcnR5TW9kdWxlJDMgPSBvYmplY3REZWZpbmVQcm9wZXJ0eTtcbnZhciBtYWtlQnVpbHRJbiA9IG1ha2VCdWlsdEluJDIuZXhwb3J0cztcbnZhciBkZWZpbmVHbG9iYWxQcm9wZXJ0eSQxID0gZGVmaW5lR2xvYmFsUHJvcGVydHkkMztcblxudmFyIGRlZmluZUJ1aWx0SW4kNSA9IGZ1bmN0aW9uIChPLCBrZXksIHZhbHVlLCBvcHRpb25zKSB7XG4gIGlmICghb3B0aW9ucykgb3B0aW9ucyA9IHt9O1xuICB2YXIgc2ltcGxlID0gb3B0aW9ucy5lbnVtZXJhYmxlO1xuICB2YXIgbmFtZSA9IG9wdGlvbnMubmFtZSAhPT0gdW5kZWZpbmVkID8gb3B0aW9ucy5uYW1lIDoga2V5O1xuICBpZiAoaXNDYWxsYWJsZSQ4KHZhbHVlKSkgbWFrZUJ1aWx0SW4odmFsdWUsIG5hbWUsIG9wdGlvbnMpO1xuICBpZiAob3B0aW9ucy5nbG9iYWwpIHtcbiAgICBpZiAoc2ltcGxlKSBPW2tleV0gPSB2YWx1ZTtcbiAgICBlbHNlIGRlZmluZUdsb2JhbFByb3BlcnR5JDEoa2V5LCB2YWx1ZSk7XG4gIH0gZWxzZSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghb3B0aW9ucy51bnNhZmUpIGRlbGV0ZSBPW2tleV07XG4gICAgICBlbHNlIGlmIChPW2tleV0pIHNpbXBsZSA9IHRydWU7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHsgLyogZW1wdHkgKi8gfVxuICAgIGlmIChzaW1wbGUpIE9ba2V5XSA9IHZhbHVlO1xuICAgIGVsc2UgZGVmaW5lUHJvcGVydHlNb2R1bGUkMy5mKE8sIGtleSwge1xuICAgICAgdmFsdWU6IHZhbHVlLFxuICAgICAgZW51bWVyYWJsZTogZmFsc2UsXG4gICAgICBjb25maWd1cmFibGU6ICFvcHRpb25zLm5vbkNvbmZpZ3VyYWJsZSxcbiAgICAgIHdyaXRhYmxlOiAhb3B0aW9ucy5ub25Xcml0YWJsZVxuICAgIH0pO1xuICB9IHJldHVybiBPO1xufTtcblxudmFyIG9iamVjdEdldE93blByb3BlcnR5TmFtZXMgPSB7fTtcblxudmFyIGNlaWwkMSA9IE1hdGguY2VpbDtcbnZhciBmbG9vciA9IE1hdGguZmxvb3I7XG5cbi8vIGBNYXRoLnRydW5jYCBtZXRob2Rcbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtbWF0aC50cnVuY1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tbWF0aC10cnVuYyAtLSBzYWZlXG52YXIgbWF0aFRydW5jID0gTWF0aC50cnVuYyB8fCBmdW5jdGlvbiB0cnVuYyh4KSB7XG4gIHZhciBuID0gK3g7XG4gIHJldHVybiAobiA+IDAgPyBmbG9vciA6IGNlaWwkMSkobik7XG59O1xuXG52YXIgdHJ1bmMgPSBtYXRoVHJ1bmM7XG5cbi8vIGBUb0ludGVnZXJPckluZmluaXR5YCBhYnN0cmFjdCBvcGVyYXRpb25cbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtdG9pbnRlZ2Vyb3JpbmZpbml0eVxudmFyIHRvSW50ZWdlck9ySW5maW5pdHkkNCA9IGZ1bmN0aW9uIChhcmd1bWVudCkge1xuICB2YXIgbnVtYmVyID0gK2FyZ3VtZW50O1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tc2VsZi1jb21wYXJlIC0tIE5hTiBjaGVja1xuICByZXR1cm4gbnVtYmVyICE9PSBudW1iZXIgfHwgbnVtYmVyID09PSAwID8gMCA6IHRydW5jKG51bWJlcik7XG59O1xuXG52YXIgdG9JbnRlZ2VyT3JJbmZpbml0eSQzID0gdG9JbnRlZ2VyT3JJbmZpbml0eSQ0O1xuXG52YXIgbWF4JDEgPSBNYXRoLm1heDtcbnZhciBtaW4kMiA9IE1hdGgubWluO1xuXG4vLyBIZWxwZXIgZm9yIGEgcG9wdWxhciByZXBlYXRpbmcgY2FzZSBvZiB0aGUgc3BlYzpcbi8vIExldCBpbnRlZ2VyIGJlID8gVG9JbnRlZ2VyKGluZGV4KS5cbi8vIElmIGludGVnZXIgPCAwLCBsZXQgcmVzdWx0IGJlIG1heCgobGVuZ3RoICsgaW50ZWdlciksIDApOyBlbHNlIGxldCByZXN1bHQgYmUgbWluKGludGVnZXIsIGxlbmd0aCkuXG52YXIgdG9BYnNvbHV0ZUluZGV4JDIgPSBmdW5jdGlvbiAoaW5kZXgsIGxlbmd0aCkge1xuICB2YXIgaW50ZWdlciA9IHRvSW50ZWdlck9ySW5maW5pdHkkMyhpbmRleCk7XG4gIHJldHVybiBpbnRlZ2VyIDwgMCA/IG1heCQxKGludGVnZXIgKyBsZW5ndGgsIDApIDogbWluJDIoaW50ZWdlciwgbGVuZ3RoKTtcbn07XG5cbnZhciB0b0ludGVnZXJPckluZmluaXR5JDIgPSB0b0ludGVnZXJPckluZmluaXR5JDQ7XG5cbnZhciBtaW4kMSA9IE1hdGgubWluO1xuXG4vLyBgVG9MZW5ndGhgIGFic3RyYWN0IG9wZXJhdGlvblxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy10b2xlbmd0aFxudmFyIHRvTGVuZ3RoJDMgPSBmdW5jdGlvbiAoYXJndW1lbnQpIHtcbiAgcmV0dXJuIGFyZ3VtZW50ID4gMCA/IG1pbiQxKHRvSW50ZWdlck9ySW5maW5pdHkkMihhcmd1bWVudCksIDB4MUZGRkZGRkZGRkZGRkYpIDogMDsgLy8gMiAqKiA1MyAtIDEgPT0gOTAwNzE5OTI1NDc0MDk5MVxufTtcblxudmFyIHRvTGVuZ3RoJDIgPSB0b0xlbmd0aCQzO1xuXG4vLyBgTGVuZ3RoT2ZBcnJheUxpa2VgIGFic3RyYWN0IG9wZXJhdGlvblxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1sZW5ndGhvZmFycmF5bGlrZVxudmFyIGxlbmd0aE9mQXJyYXlMaWtlJDIgPSBmdW5jdGlvbiAob2JqKSB7XG4gIHJldHVybiB0b0xlbmd0aCQyKG9iai5sZW5ndGgpO1xufTtcblxudmFyIHRvSW5kZXhlZE9iamVjdCQzID0gdG9JbmRleGVkT2JqZWN0JDU7XG52YXIgdG9BYnNvbHV0ZUluZGV4JDEgPSB0b0Fic29sdXRlSW5kZXgkMjtcbnZhciBsZW5ndGhPZkFycmF5TGlrZSQxID0gbGVuZ3RoT2ZBcnJheUxpa2UkMjtcblxuLy8gYEFycmF5LnByb3RvdHlwZS57IGluZGV4T2YsIGluY2x1ZGVzIH1gIG1ldGhvZHMgaW1wbGVtZW50YXRpb25cbnZhciBjcmVhdGVNZXRob2QkMyA9IGZ1bmN0aW9uIChJU19JTkNMVURFUykge1xuICByZXR1cm4gZnVuY3Rpb24gKCR0aGlzLCBlbCwgZnJvbUluZGV4KSB7XG4gICAgdmFyIE8gPSB0b0luZGV4ZWRPYmplY3QkMygkdGhpcyk7XG4gICAgdmFyIGxlbmd0aCA9IGxlbmd0aE9mQXJyYXlMaWtlJDEoTyk7XG4gICAgdmFyIGluZGV4ID0gdG9BYnNvbHV0ZUluZGV4JDEoZnJvbUluZGV4LCBsZW5ndGgpO1xuICAgIHZhciB2YWx1ZTtcbiAgICAvLyBBcnJheSNpbmNsdWRlcyB1c2VzIFNhbWVWYWx1ZVplcm8gZXF1YWxpdHkgYWxnb3JpdGhtXG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLXNlbGYtY29tcGFyZSAtLSBOYU4gY2hlY2tcbiAgICBpZiAoSVNfSU5DTFVERVMgJiYgZWwgIT0gZWwpIHdoaWxlIChsZW5ndGggPiBpbmRleCkge1xuICAgICAgdmFsdWUgPSBPW2luZGV4KytdO1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLXNlbGYtY29tcGFyZSAtLSBOYU4gY2hlY2tcbiAgICAgIGlmICh2YWx1ZSAhPSB2YWx1ZSkgcmV0dXJuIHRydWU7XG4gICAgLy8gQXJyYXkjaW5kZXhPZiBpZ25vcmVzIGhvbGVzLCBBcnJheSNpbmNsdWRlcyAtIG5vdFxuICAgIH0gZWxzZSBmb3IgKDtsZW5ndGggPiBpbmRleDsgaW5kZXgrKykge1xuICAgICAgaWYgKChJU19JTkNMVURFUyB8fCBpbmRleCBpbiBPKSAmJiBPW2luZGV4XSA9PT0gZWwpIHJldHVybiBJU19JTkNMVURFUyB8fCBpbmRleCB8fCAwO1xuICAgIH0gcmV0dXJuICFJU19JTkNMVURFUyAmJiAtMTtcbiAgfTtcbn07XG5cbnZhciBhcnJheUluY2x1ZGVzID0ge1xuICAvLyBgQXJyYXkucHJvdG90eXBlLmluY2x1ZGVzYCBtZXRob2RcbiAgLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1hcnJheS5wcm90b3R5cGUuaW5jbHVkZXNcbiAgaW5jbHVkZXM6IGNyZWF0ZU1ldGhvZCQzKHRydWUpLFxuICAvLyBgQXJyYXkucHJvdG90eXBlLmluZGV4T2ZgIG1ldGhvZFxuICAvLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLWFycmF5LnByb3RvdHlwZS5pbmRleG9mXG4gIGluZGV4T2Y6IGNyZWF0ZU1ldGhvZCQzKGZhbHNlKVxufTtcblxudmFyIHVuY3VycnlUaGlzJGIgPSBmdW5jdGlvblVuY3VycnlUaGlzO1xudmFyIGhhc093biQ0ID0gaGFzT3duUHJvcGVydHlfMTtcbnZhciB0b0luZGV4ZWRPYmplY3QkMiA9IHRvSW5kZXhlZE9iamVjdCQ1O1xudmFyIGluZGV4T2YkMSA9IGFycmF5SW5jbHVkZXMuaW5kZXhPZjtcbnZhciBoaWRkZW5LZXlzJDIgPSBoaWRkZW5LZXlzJDQ7XG5cbnZhciBwdXNoJDEgPSB1bmN1cnJ5VGhpcyRiKFtdLnB1c2gpO1xuXG52YXIgb2JqZWN0S2V5c0ludGVybmFsID0gZnVuY3Rpb24gKG9iamVjdCwgbmFtZXMpIHtcbiAgdmFyIE8gPSB0b0luZGV4ZWRPYmplY3QkMihvYmplY3QpO1xuICB2YXIgaSA9IDA7XG4gIHZhciByZXN1bHQgPSBbXTtcbiAgdmFyIGtleTtcbiAgZm9yIChrZXkgaW4gTykgIWhhc093biQ0KGhpZGRlbktleXMkMiwga2V5KSAmJiBoYXNPd24kNChPLCBrZXkpICYmIHB1c2gkMShyZXN1bHQsIGtleSk7XG4gIC8vIERvbid0IGVudW0gYnVnICYgaGlkZGVuIGtleXNcbiAgd2hpbGUgKG5hbWVzLmxlbmd0aCA+IGkpIGlmIChoYXNPd24kNChPLCBrZXkgPSBuYW1lc1tpKytdKSkge1xuICAgIH5pbmRleE9mJDEocmVzdWx0LCBrZXkpIHx8IHB1c2gkMShyZXN1bHQsIGtleSk7XG4gIH1cbiAgcmV0dXJuIHJlc3VsdDtcbn07XG5cbi8vIElFOC0gZG9uJ3QgZW51bSBidWcga2V5c1xudmFyIGVudW1CdWdLZXlzJDMgPSBbXG4gICdjb25zdHJ1Y3RvcicsXG4gICdoYXNPd25Qcm9wZXJ0eScsXG4gICdpc1Byb3RvdHlwZU9mJyxcbiAgJ3Byb3BlcnR5SXNFbnVtZXJhYmxlJyxcbiAgJ3RvTG9jYWxlU3RyaW5nJyxcbiAgJ3RvU3RyaW5nJyxcbiAgJ3ZhbHVlT2YnXG5dO1xuXG52YXIgaW50ZXJuYWxPYmplY3RLZXlzJDEgPSBvYmplY3RLZXlzSW50ZXJuYWw7XG52YXIgZW51bUJ1Z0tleXMkMiA9IGVudW1CdWdLZXlzJDM7XG5cbnZhciBoaWRkZW5LZXlzJDEgPSBlbnVtQnVnS2V5cyQyLmNvbmNhdCgnbGVuZ3RoJywgJ3Byb3RvdHlwZScpO1xuXG4vLyBgT2JqZWN0LmdldE93blByb3BlcnR5TmFtZXNgIG1ldGhvZFxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1vYmplY3QuZ2V0b3ducHJvcGVydHluYW1lc1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tb2JqZWN0LWdldG93bnByb3BlcnR5bmFtZXMgLS0gc2FmZVxub2JqZWN0R2V0T3duUHJvcGVydHlOYW1lcy5mID0gT2JqZWN0LmdldE93blByb3BlcnR5TmFtZXMgfHwgZnVuY3Rpb24gZ2V0T3duUHJvcGVydHlOYW1lcyhPKSB7XG4gIHJldHVybiBpbnRlcm5hbE9iamVjdEtleXMkMShPLCBoaWRkZW5LZXlzJDEpO1xufTtcblxudmFyIG9iamVjdEdldE93blByb3BlcnR5U3ltYm9scyA9IHt9O1xuXG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZXMteC9uby1vYmplY3QtZ2V0b3ducHJvcGVydHlzeW1ib2xzIC0tIHNhZmVcbm9iamVjdEdldE93blByb3BlcnR5U3ltYm9scy5mID0gT2JqZWN0LmdldE93blByb3BlcnR5U3ltYm9scztcblxudmFyIGdldEJ1aWx0SW4kMiA9IGdldEJ1aWx0SW4kNTtcbnZhciB1bmN1cnJ5VGhpcyRhID0gZnVuY3Rpb25VbmN1cnJ5VGhpcztcbnZhciBnZXRPd25Qcm9wZXJ0eU5hbWVzTW9kdWxlID0gb2JqZWN0R2V0T3duUHJvcGVydHlOYW1lcztcbnZhciBnZXRPd25Qcm9wZXJ0eVN5bWJvbHNNb2R1bGUkMSA9IG9iamVjdEdldE93blByb3BlcnR5U3ltYm9scztcbnZhciBhbk9iamVjdCQ4ID0gYW5PYmplY3QkYTtcblxudmFyIGNvbmNhdCQxID0gdW5jdXJyeVRoaXMkYShbXS5jb25jYXQpO1xuXG4vLyBhbGwgb2JqZWN0IGtleXMsIGluY2x1ZGVzIG5vbi1lbnVtZXJhYmxlIGFuZCBzeW1ib2xzXG52YXIgb3duS2V5cyQxID0gZ2V0QnVpbHRJbiQyKCdSZWZsZWN0JywgJ293bktleXMnKSB8fCBmdW5jdGlvbiBvd25LZXlzKGl0KSB7XG4gIHZhciBrZXlzID0gZ2V0T3duUHJvcGVydHlOYW1lc01vZHVsZS5mKGFuT2JqZWN0JDgoaXQpKTtcbiAgdmFyIGdldE93blByb3BlcnR5U3ltYm9scyA9IGdldE93blByb3BlcnR5U3ltYm9sc01vZHVsZSQxLmY7XG4gIHJldHVybiBnZXRPd25Qcm9wZXJ0eVN5bWJvbHMgPyBjb25jYXQkMShrZXlzLCBnZXRPd25Qcm9wZXJ0eVN5bWJvbHMoaXQpKSA6IGtleXM7XG59O1xuXG52YXIgaGFzT3duJDMgPSBoYXNPd25Qcm9wZXJ0eV8xO1xudmFyIG93bktleXMgPSBvd25LZXlzJDE7XG52YXIgZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yTW9kdWxlID0gb2JqZWN0R2V0T3duUHJvcGVydHlEZXNjcmlwdG9yO1xudmFyIGRlZmluZVByb3BlcnR5TW9kdWxlJDIgPSBvYmplY3REZWZpbmVQcm9wZXJ0eTtcblxudmFyIGNvcHlDb25zdHJ1Y3RvclByb3BlcnRpZXMkMSA9IGZ1bmN0aW9uICh0YXJnZXQsIHNvdXJjZSwgZXhjZXB0aW9ucykge1xuICB2YXIga2V5cyA9IG93bktleXMoc291cmNlKTtcbiAgdmFyIGRlZmluZVByb3BlcnR5ID0gZGVmaW5lUHJvcGVydHlNb2R1bGUkMi5mO1xuICB2YXIgZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yID0gZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yTW9kdWxlLmY7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwga2V5cy5sZW5ndGg7IGkrKykge1xuICAgIHZhciBrZXkgPSBrZXlzW2ldO1xuICAgIGlmICghaGFzT3duJDModGFyZ2V0LCBrZXkpICYmICEoZXhjZXB0aW9ucyAmJiBoYXNPd24kMyhleGNlcHRpb25zLCBrZXkpKSkge1xuICAgICAgZGVmaW5lUHJvcGVydHkodGFyZ2V0LCBrZXksIGdldE93blByb3BlcnR5RGVzY3JpcHRvcihzb3VyY2UsIGtleSkpO1xuICAgIH1cbiAgfVxufTtcblxudmFyIGZhaWxzJGIgPSBmYWlscyRqO1xudmFyIGlzQ2FsbGFibGUkNyA9IGlzQ2FsbGFibGUkaDtcblxudmFyIHJlcGxhY2VtZW50ID0gLyN8XFwucHJvdG90eXBlXFwuLztcblxudmFyIGlzRm9yY2VkJDEgPSBmdW5jdGlvbiAoZmVhdHVyZSwgZGV0ZWN0aW9uKSB7XG4gIHZhciB2YWx1ZSA9IGRhdGFbbm9ybWFsaXplKGZlYXR1cmUpXTtcbiAgcmV0dXJuIHZhbHVlID09IFBPTFlGSUxMID8gdHJ1ZVxuICAgIDogdmFsdWUgPT0gTkFUSVZFID8gZmFsc2VcbiAgICA6IGlzQ2FsbGFibGUkNyhkZXRlY3Rpb24pID8gZmFpbHMkYihkZXRlY3Rpb24pXG4gICAgOiAhIWRldGVjdGlvbjtcbn07XG5cbnZhciBub3JtYWxpemUgPSBpc0ZvcmNlZCQxLm5vcm1hbGl6ZSA9IGZ1bmN0aW9uIChzdHJpbmcpIHtcbiAgcmV0dXJuIFN0cmluZyhzdHJpbmcpLnJlcGxhY2UocmVwbGFjZW1lbnQsICcuJykudG9Mb3dlckNhc2UoKTtcbn07XG5cbnZhciBkYXRhID0gaXNGb3JjZWQkMS5kYXRhID0ge307XG52YXIgTkFUSVZFID0gaXNGb3JjZWQkMS5OQVRJVkUgPSAnTic7XG52YXIgUE9MWUZJTEwgPSBpc0ZvcmNlZCQxLlBPTFlGSUxMID0gJ1AnO1xuXG52YXIgaXNGb3JjZWRfMSA9IGlzRm9yY2VkJDE7XG5cbnZhciBnbG9iYWwkNiA9IGdsb2JhbCRmO1xudmFyIGdldE93blByb3BlcnR5RGVzY3JpcHRvciA9IG9iamVjdEdldE93blByb3BlcnR5RGVzY3JpcHRvci5mO1xudmFyIGNyZWF0ZU5vbkVudW1lcmFibGVQcm9wZXJ0eSQzID0gY3JlYXRlTm9uRW51bWVyYWJsZVByb3BlcnR5JDU7XG52YXIgZGVmaW5lQnVpbHRJbiQ0ID0gZGVmaW5lQnVpbHRJbiQ1O1xudmFyIGRlZmluZUdsb2JhbFByb3BlcnR5ID0gZGVmaW5lR2xvYmFsUHJvcGVydHkkMztcbnZhciBjb3B5Q29uc3RydWN0b3JQcm9wZXJ0aWVzID0gY29weUNvbnN0cnVjdG9yUHJvcGVydGllcyQxO1xudmFyIGlzRm9yY2VkID0gaXNGb3JjZWRfMTtcblxuLypcbiAgb3B0aW9ucy50YXJnZXQgICAgICAgICAtIG5hbWUgb2YgdGhlIHRhcmdldCBvYmplY3RcbiAgb3B0aW9ucy5nbG9iYWwgICAgICAgICAtIHRhcmdldCBpcyB0aGUgZ2xvYmFsIG9iamVjdFxuICBvcHRpb25zLnN0YXQgICAgICAgICAgIC0gZXhwb3J0IGFzIHN0YXRpYyBtZXRob2RzIG9mIHRhcmdldFxuICBvcHRpb25zLnByb3RvICAgICAgICAgIC0gZXhwb3J0IGFzIHByb3RvdHlwZSBtZXRob2RzIG9mIHRhcmdldFxuICBvcHRpb25zLnJlYWwgICAgICAgICAgIC0gcmVhbCBwcm90b3R5cGUgbWV0aG9kIGZvciB0aGUgYHB1cmVgIHZlcnNpb25cbiAgb3B0aW9ucy5mb3JjZWQgICAgICAgICAtIGV4cG9ydCBldmVuIGlmIHRoZSBuYXRpdmUgZmVhdHVyZSBpcyBhdmFpbGFibGVcbiAgb3B0aW9ucy5iaW5kICAgICAgICAgICAtIGJpbmQgbWV0aG9kcyB0byB0aGUgdGFyZ2V0LCByZXF1aXJlZCBmb3IgdGhlIGBwdXJlYCB2ZXJzaW9uXG4gIG9wdGlvbnMud3JhcCAgICAgICAgICAgLSB3cmFwIGNvbnN0cnVjdG9ycyB0byBwcmV2ZW50aW5nIGdsb2JhbCBwb2xsdXRpb24sIHJlcXVpcmVkIGZvciB0aGUgYHB1cmVgIHZlcnNpb25cbiAgb3B0aW9ucy51bnNhZmUgICAgICAgICAtIHVzZSB0aGUgc2ltcGxlIGFzc2lnbm1lbnQgb2YgcHJvcGVydHkgaW5zdGVhZCBvZiBkZWxldGUgKyBkZWZpbmVQcm9wZXJ0eVxuICBvcHRpb25zLnNoYW0gICAgICAgICAgIC0gYWRkIGEgZmxhZyB0byBub3QgY29tcGxldGVseSBmdWxsIHBvbHlmaWxsc1xuICBvcHRpb25zLmVudW1lcmFibGUgICAgIC0gZXhwb3J0IGFzIGVudW1lcmFibGUgcHJvcGVydHlcbiAgb3B0aW9ucy5kb250Q2FsbEdldFNldCAtIHByZXZlbnQgY2FsbGluZyBhIGdldHRlciBvbiB0YXJnZXRcbiAgb3B0aW9ucy5uYW1lICAgICAgICAgICAtIHRoZSAubmFtZSBvZiB0aGUgZnVuY3Rpb24gaWYgaXQgZG9lcyBub3QgbWF0Y2ggdGhlIGtleVxuKi9cbnZhciBfZXhwb3J0ID0gZnVuY3Rpb24gKG9wdGlvbnMsIHNvdXJjZSkge1xuICB2YXIgVEFSR0VUID0gb3B0aW9ucy50YXJnZXQ7XG4gIHZhciBHTE9CQUwgPSBvcHRpb25zLmdsb2JhbDtcbiAgdmFyIFNUQVRJQyA9IG9wdGlvbnMuc3RhdDtcbiAgdmFyIEZPUkNFRCwgdGFyZ2V0LCBrZXksIHRhcmdldFByb3BlcnR5LCBzb3VyY2VQcm9wZXJ0eSwgZGVzY3JpcHRvcjtcbiAgaWYgKEdMT0JBTCkge1xuICAgIHRhcmdldCA9IGdsb2JhbCQ2O1xuICB9IGVsc2UgaWYgKFNUQVRJQykge1xuICAgIHRhcmdldCA9IGdsb2JhbCQ2W1RBUkdFVF0gfHwgZGVmaW5lR2xvYmFsUHJvcGVydHkoVEFSR0VULCB7fSk7XG4gIH0gZWxzZSB7XG4gICAgdGFyZ2V0ID0gKGdsb2JhbCQ2W1RBUkdFVF0gfHwge30pLnByb3RvdHlwZTtcbiAgfVxuICBpZiAodGFyZ2V0KSBmb3IgKGtleSBpbiBzb3VyY2UpIHtcbiAgICBzb3VyY2VQcm9wZXJ0eSA9IHNvdXJjZVtrZXldO1xuICAgIGlmIChvcHRpb25zLmRvbnRDYWxsR2V0U2V0KSB7XG4gICAgICBkZXNjcmlwdG9yID0gZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHRhcmdldCwga2V5KTtcbiAgICAgIHRhcmdldFByb3BlcnR5ID0gZGVzY3JpcHRvciAmJiBkZXNjcmlwdG9yLnZhbHVlO1xuICAgIH0gZWxzZSB0YXJnZXRQcm9wZXJ0eSA9IHRhcmdldFtrZXldO1xuICAgIEZPUkNFRCA9IGlzRm9yY2VkKEdMT0JBTCA/IGtleSA6IFRBUkdFVCArIChTVEFUSUMgPyAnLicgOiAnIycpICsga2V5LCBvcHRpb25zLmZvcmNlZCk7XG4gICAgLy8gY29udGFpbmVkIGluIHRhcmdldFxuICAgIGlmICghRk9SQ0VEICYmIHRhcmdldFByb3BlcnR5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmICh0eXBlb2Ygc291cmNlUHJvcGVydHkgPT0gdHlwZW9mIHRhcmdldFByb3BlcnR5KSBjb250aW51ZTtcbiAgICAgIGNvcHlDb25zdHJ1Y3RvclByb3BlcnRpZXMoc291cmNlUHJvcGVydHksIHRhcmdldFByb3BlcnR5KTtcbiAgICB9XG4gICAgLy8gYWRkIGEgZmxhZyB0byBub3QgY29tcGxldGVseSBmdWxsIHBvbHlmaWxsc1xuICAgIGlmIChvcHRpb25zLnNoYW0gfHwgKHRhcmdldFByb3BlcnR5ICYmIHRhcmdldFByb3BlcnR5LnNoYW0pKSB7XG4gICAgICBjcmVhdGVOb25FbnVtZXJhYmxlUHJvcGVydHkkMyhzb3VyY2VQcm9wZXJ0eSwgJ3NoYW0nLCB0cnVlKTtcbiAgICB9XG4gICAgZGVmaW5lQnVpbHRJbiQ0KHRhcmdldCwga2V5LCBzb3VyY2VQcm9wZXJ0eSwgb3B0aW9ucyk7XG4gIH1cbn07XG5cbnZhciB3ZWxsS25vd25TeW1ib2wkOSA9IHdlbGxLbm93blN5bWJvbCRiO1xuXG52YXIgVE9fU1RSSU5HX1RBRyQzID0gd2VsbEtub3duU3ltYm9sJDkoJ3RvU3RyaW5nVGFnJyk7XG52YXIgdGVzdCA9IHt9O1xuXG50ZXN0W1RPX1NUUklOR19UQUckM10gPSAneic7XG5cbnZhciB0b1N0cmluZ1RhZ1N1cHBvcnQgPSBTdHJpbmcodGVzdCkgPT09ICdbb2JqZWN0IHpdJztcblxudmFyIFRPX1NUUklOR19UQUdfU1VQUE9SVCA9IHRvU3RyaW5nVGFnU3VwcG9ydDtcbnZhciBpc0NhbGxhYmxlJDYgPSBpc0NhbGxhYmxlJGg7XG52YXIgY2xhc3NvZlJhdyA9IGNsYXNzb2ZSYXckMTtcbnZhciB3ZWxsS25vd25TeW1ib2wkOCA9IHdlbGxLbm93blN5bWJvbCRiO1xuXG52YXIgVE9fU1RSSU5HX1RBRyQyID0gd2VsbEtub3duU3ltYm9sJDgoJ3RvU3RyaW5nVGFnJyk7XG52YXIgJE9iamVjdCQxID0gT2JqZWN0O1xuXG4vLyBFUzMgd3JvbmcgaGVyZVxudmFyIENPUlJFQ1RfQVJHVU1FTlRTID0gY2xhc3NvZlJhdyhmdW5jdGlvbiAoKSB7IHJldHVybiBhcmd1bWVudHM7IH0oKSkgPT0gJ0FyZ3VtZW50cyc7XG5cbi8vIGZhbGxiYWNrIGZvciBJRTExIFNjcmlwdCBBY2Nlc3MgRGVuaWVkIGVycm9yXG52YXIgdHJ5R2V0ID0gZnVuY3Rpb24gKGl0LCBrZXkpIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gaXRba2V5XTtcbiAgfSBjYXRjaCAoZXJyb3IpIHsgLyogZW1wdHkgKi8gfVxufTtcblxuLy8gZ2V0dGluZyB0YWcgZnJvbSBFUzYrIGBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nYFxudmFyIGNsYXNzb2YkNCA9IFRPX1NUUklOR19UQUdfU1VQUE9SVCA/IGNsYXNzb2ZSYXcgOiBmdW5jdGlvbiAoaXQpIHtcbiAgdmFyIE8sIHRhZywgcmVzdWx0O1xuICByZXR1cm4gaXQgPT09IHVuZGVmaW5lZCA/ICdVbmRlZmluZWQnIDogaXQgPT09IG51bGwgPyAnTnVsbCdcbiAgICAvLyBAQHRvU3RyaW5nVGFnIGNhc2VcbiAgICA6IHR5cGVvZiAodGFnID0gdHJ5R2V0KE8gPSAkT2JqZWN0JDEoaXQpLCBUT19TVFJJTkdfVEFHJDIpKSA9PSAnc3RyaW5nJyA/IHRhZ1xuICAgIC8vIGJ1aWx0aW5UYWcgY2FzZVxuICAgIDogQ09SUkVDVF9BUkdVTUVOVFMgPyBjbGFzc29mUmF3KE8pXG4gICAgLy8gRVMzIGFyZ3VtZW50cyBmYWxsYmFja1xuICAgIDogKHJlc3VsdCA9IGNsYXNzb2ZSYXcoTykpID09ICdPYmplY3QnICYmIGlzQ2FsbGFibGUkNihPLmNhbGxlZSkgPyAnQXJndW1lbnRzJyA6IHJlc3VsdDtcbn07XG5cbnZhciBjbGFzc29mJDMgPSBjbGFzc29mJDQ7XG5cbnZhciAkU3RyaW5nJDEgPSBTdHJpbmc7XG5cbnZhciB0b1N0cmluZyQ3ID0gZnVuY3Rpb24gKGFyZ3VtZW50KSB7XG4gIGlmIChjbGFzc29mJDMoYXJndW1lbnQpID09PSAnU3ltYm9sJykgdGhyb3cgVHlwZUVycm9yKCdDYW5ub3QgY29udmVydCBhIFN5bWJvbCB2YWx1ZSB0byBhIHN0cmluZycpO1xuICByZXR1cm4gJFN0cmluZyQxKGFyZ3VtZW50KTtcbn07XG5cbnZhciBhbk9iamVjdCQ3ID0gYW5PYmplY3QkYTtcblxuLy8gYFJlZ0V4cC5wcm90b3R5cGUuZmxhZ3NgIGdldHRlciBpbXBsZW1lbnRhdGlvblxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1nZXQtcmVnZXhwLnByb3RvdHlwZS5mbGFnc1xudmFyIHJlZ2V4cEZsYWdzJDEgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciB0aGF0ID0gYW5PYmplY3QkNyh0aGlzKTtcbiAgdmFyIHJlc3VsdCA9ICcnO1xuICBpZiAodGhhdC5oYXNJbmRpY2VzKSByZXN1bHQgKz0gJ2QnO1xuICBpZiAodGhhdC5nbG9iYWwpIHJlc3VsdCArPSAnZyc7XG4gIGlmICh0aGF0Lmlnbm9yZUNhc2UpIHJlc3VsdCArPSAnaSc7XG4gIGlmICh0aGF0Lm11bHRpbGluZSkgcmVzdWx0ICs9ICdtJztcbiAgaWYgKHRoYXQuZG90QWxsKSByZXN1bHQgKz0gJ3MnO1xuICBpZiAodGhhdC51bmljb2RlKSByZXN1bHQgKz0gJ3UnO1xuICBpZiAodGhhdC51bmljb2RlU2V0cykgcmVzdWx0ICs9ICd2JztcbiAgaWYgKHRoYXQuc3RpY2t5KSByZXN1bHQgKz0gJ3knO1xuICByZXR1cm4gcmVzdWx0O1xufTtcblxudmFyIGZhaWxzJGEgPSBmYWlscyRqO1xudmFyIGdsb2JhbCQ1ID0gZ2xvYmFsJGY7XG5cbi8vIGJhYmVsLW1pbmlmeSBhbmQgQ2xvc3VyZSBDb21waWxlciB0cmFuc3BpbGVzIFJlZ0V4cCgnYScsICd5JykgLT4gL2EveSBhbmQgaXQgY2F1c2VzIFN5bnRheEVycm9yXG52YXIgJFJlZ0V4cCQyID0gZ2xvYmFsJDUuUmVnRXhwO1xuXG52YXIgVU5TVVBQT1JURURfWSQyID0gZmFpbHMkYShmdW5jdGlvbiAoKSB7XG4gIHZhciByZSA9ICRSZWdFeHAkMignYScsICd5Jyk7XG4gIHJlLmxhc3RJbmRleCA9IDI7XG4gIHJldHVybiByZS5leGVjKCdhYmNkJykgIT0gbnVsbDtcbn0pO1xuXG4vLyBVQyBCcm93c2VyIGJ1Z1xuLy8gaHR0cHM6Ly9naXRodWIuY29tL3psb2lyb2NrL2NvcmUtanMvaXNzdWVzLzEwMDhcbnZhciBNSVNTRURfU1RJQ0tZID0gVU5TVVBQT1JURURfWSQyIHx8IGZhaWxzJGEoZnVuY3Rpb24gKCkge1xuICByZXR1cm4gISRSZWdFeHAkMignYScsICd5Jykuc3RpY2t5O1xufSk7XG5cbnZhciBCUk9LRU5fQ0FSRVQgPSBVTlNVUFBPUlRFRF9ZJDIgfHwgZmFpbHMkYShmdW5jdGlvbiAoKSB7XG4gIC8vIGh0dHBzOi8vYnVnemlsbGEubW96aWxsYS5vcmcvc2hvd19idWcuY2dpP2lkPTc3MzY4N1xuICB2YXIgcmUgPSAkUmVnRXhwJDIoJ15yJywgJ2d5Jyk7XG4gIHJlLmxhc3RJbmRleCA9IDI7XG4gIHJldHVybiByZS5leGVjKCdzdHInKSAhPSBudWxsO1xufSk7XG5cbnZhciByZWdleHBTdGlja3lIZWxwZXJzID0ge1xuICBCUk9LRU5fQ0FSRVQ6IEJST0tFTl9DQVJFVCxcbiAgTUlTU0VEX1NUSUNLWTogTUlTU0VEX1NUSUNLWSxcbiAgVU5TVVBQT1JURURfWTogVU5TVVBQT1JURURfWSQyXG59O1xuXG52YXIgb2JqZWN0RGVmaW5lUHJvcGVydGllcyA9IHt9O1xuXG52YXIgaW50ZXJuYWxPYmplY3RLZXlzID0gb2JqZWN0S2V5c0ludGVybmFsO1xudmFyIGVudW1CdWdLZXlzJDEgPSBlbnVtQnVnS2V5cyQzO1xuXG4vLyBgT2JqZWN0LmtleXNgIG1ldGhvZFxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1vYmplY3Qua2V5c1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tb2JqZWN0LWtleXMgLS0gc2FmZVxudmFyIG9iamVjdEtleXMkMiA9IE9iamVjdC5rZXlzIHx8IGZ1bmN0aW9uIGtleXMoTykge1xuICByZXR1cm4gaW50ZXJuYWxPYmplY3RLZXlzKE8sIGVudW1CdWdLZXlzJDEpO1xufTtcblxudmFyIERFU0NSSVBUT1JTJDIgPSBkZXNjcmlwdG9ycztcbnZhciBWOF9QUk9UT1RZUEVfREVGSU5FX0JVRyA9IHY4UHJvdG90eXBlRGVmaW5lQnVnO1xudmFyIGRlZmluZVByb3BlcnR5TW9kdWxlJDEgPSBvYmplY3REZWZpbmVQcm9wZXJ0eTtcbnZhciBhbk9iamVjdCQ2ID0gYW5PYmplY3QkYTtcbnZhciB0b0luZGV4ZWRPYmplY3QkMSA9IHRvSW5kZXhlZE9iamVjdCQ1O1xudmFyIG9iamVjdEtleXMkMSA9IG9iamVjdEtleXMkMjtcblxuLy8gYE9iamVjdC5kZWZpbmVQcm9wZXJ0aWVzYCBtZXRob2Rcbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtb2JqZWN0LmRlZmluZXByb3BlcnRpZXNcbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBlcy14L25vLW9iamVjdC1kZWZpbmVwcm9wZXJ0aWVzIC0tIHNhZmVcbm9iamVjdERlZmluZVByb3BlcnRpZXMuZiA9IERFU0NSSVBUT1JTJDIgJiYgIVY4X1BST1RPVFlQRV9ERUZJTkVfQlVHID8gT2JqZWN0LmRlZmluZVByb3BlcnRpZXMgOiBmdW5jdGlvbiBkZWZpbmVQcm9wZXJ0aWVzKE8sIFByb3BlcnRpZXMpIHtcbiAgYW5PYmplY3QkNihPKTtcbiAgdmFyIHByb3BzID0gdG9JbmRleGVkT2JqZWN0JDEoUHJvcGVydGllcyk7XG4gIHZhciBrZXlzID0gb2JqZWN0S2V5cyQxKFByb3BlcnRpZXMpO1xuICB2YXIgbGVuZ3RoID0ga2V5cy5sZW5ndGg7XG4gIHZhciBpbmRleCA9IDA7XG4gIHZhciBrZXk7XG4gIHdoaWxlIChsZW5ndGggPiBpbmRleCkgZGVmaW5lUHJvcGVydHlNb2R1bGUkMS5mKE8sIGtleSA9IGtleXNbaW5kZXgrK10sIHByb3BzW2tleV0pO1xuICByZXR1cm4gTztcbn07XG5cbnZhciBnZXRCdWlsdEluJDEgPSBnZXRCdWlsdEluJDU7XG5cbnZhciBodG1sJDEgPSBnZXRCdWlsdEluJDEoJ2RvY3VtZW50JywgJ2RvY3VtZW50RWxlbWVudCcpO1xuXG4vKiBnbG9iYWwgQWN0aXZlWE9iamVjdCAtLSBvbGQgSUUsIFdTSCAqL1xuXG52YXIgYW5PYmplY3QkNSA9IGFuT2JqZWN0JGE7XG52YXIgZGVmaW5lUHJvcGVydGllc01vZHVsZSA9IG9iamVjdERlZmluZVByb3BlcnRpZXM7XG52YXIgZW51bUJ1Z0tleXMgPSBlbnVtQnVnS2V5cyQzO1xudmFyIGhpZGRlbktleXMgPSBoaWRkZW5LZXlzJDQ7XG52YXIgaHRtbCA9IGh0bWwkMTtcbnZhciBkb2N1bWVudENyZWF0ZUVsZW1lbnQkMSA9IGRvY3VtZW50Q3JlYXRlRWxlbWVudCQyO1xudmFyIHNoYXJlZEtleSQxID0gc2hhcmVkS2V5JDM7XG5cbnZhciBHVCA9ICc+JztcbnZhciBMVCA9ICc8JztcbnZhciBQUk9UT1RZUEUgPSAncHJvdG90eXBlJztcbnZhciBTQ1JJUFQgPSAnc2NyaXB0JztcbnZhciBJRV9QUk9UTyQxID0gc2hhcmVkS2V5JDEoJ0lFX1BST1RPJyk7XG5cbnZhciBFbXB0eUNvbnN0cnVjdG9yID0gZnVuY3Rpb24gKCkgeyAvKiBlbXB0eSAqLyB9O1xuXG52YXIgc2NyaXB0VGFnID0gZnVuY3Rpb24gKGNvbnRlbnQpIHtcbiAgcmV0dXJuIExUICsgU0NSSVBUICsgR1QgKyBjb250ZW50ICsgTFQgKyAnLycgKyBTQ1JJUFQgKyBHVDtcbn07XG5cbi8vIENyZWF0ZSBvYmplY3Qgd2l0aCBmYWtlIGBudWxsYCBwcm90b3R5cGU6IHVzZSBBY3RpdmVYIE9iamVjdCB3aXRoIGNsZWFyZWQgcHJvdG90eXBlXG52YXIgTnVsbFByb3RvT2JqZWN0VmlhQWN0aXZlWCA9IGZ1bmN0aW9uIChhY3RpdmVYRG9jdW1lbnQpIHtcbiAgYWN0aXZlWERvY3VtZW50LndyaXRlKHNjcmlwdFRhZygnJykpO1xuICBhY3RpdmVYRG9jdW1lbnQuY2xvc2UoKTtcbiAgdmFyIHRlbXAgPSBhY3RpdmVYRG9jdW1lbnQucGFyZW50V2luZG93Lk9iamVjdDtcbiAgYWN0aXZlWERvY3VtZW50ID0gbnVsbDsgLy8gYXZvaWQgbWVtb3J5IGxlYWtcbiAgcmV0dXJuIHRlbXA7XG59O1xuXG4vLyBDcmVhdGUgb2JqZWN0IHdpdGggZmFrZSBgbnVsbGAgcHJvdG90eXBlOiB1c2UgaWZyYW1lIE9iamVjdCB3aXRoIGNsZWFyZWQgcHJvdG90eXBlXG52YXIgTnVsbFByb3RvT2JqZWN0VmlhSUZyYW1lID0gZnVuY3Rpb24gKCkge1xuICAvLyBUaHJhc2gsIHdhc3RlIGFuZCBzb2RvbXk6IElFIEdDIGJ1Z1xuICB2YXIgaWZyYW1lID0gZG9jdW1lbnRDcmVhdGVFbGVtZW50JDEoJ2lmcmFtZScpO1xuICB2YXIgSlMgPSAnamF2YScgKyBTQ1JJUFQgKyAnOic7XG4gIHZhciBpZnJhbWVEb2N1bWVudDtcbiAgaWZyYW1lLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gIGh0bWwuYXBwZW5kQ2hpbGQoaWZyYW1lKTtcbiAgLy8gaHR0cHM6Ly9naXRodWIuY29tL3psb2lyb2NrL2NvcmUtanMvaXNzdWVzLzQ3NVxuICBpZnJhbWUuc3JjID0gU3RyaW5nKEpTKTtcbiAgaWZyYW1lRG9jdW1lbnQgPSBpZnJhbWUuY29udGVudFdpbmRvdy5kb2N1bWVudDtcbiAgaWZyYW1lRG9jdW1lbnQub3BlbigpO1xuICBpZnJhbWVEb2N1bWVudC53cml0ZShzY3JpcHRUYWcoJ2RvY3VtZW50LkY9T2JqZWN0JykpO1xuICBpZnJhbWVEb2N1bWVudC5jbG9zZSgpO1xuICByZXR1cm4gaWZyYW1lRG9jdW1lbnQuRjtcbn07XG5cbi8vIENoZWNrIGZvciBkb2N1bWVudC5kb21haW4gYW5kIGFjdGl2ZSB4IHN1cHBvcnRcbi8vIE5vIG5lZWQgdG8gdXNlIGFjdGl2ZSB4IGFwcHJvYWNoIHdoZW4gZG9jdW1lbnQuZG9tYWluIGlzIG5vdCBzZXRcbi8vIHNlZSBodHRwczovL2dpdGh1Yi5jb20vZXMtc2hpbXMvZXM1LXNoaW0vaXNzdWVzLzE1MFxuLy8gdmFyaWF0aW9uIG9mIGh0dHBzOi8vZ2l0aHViLmNvbS9raXRjYW1icmlkZ2UvZXM1LXNoaW0vY29tbWl0LzRmNzM4YWMwNjYzNDZcbi8vIGF2b2lkIElFIEdDIGJ1Z1xudmFyIGFjdGl2ZVhEb2N1bWVudDtcbnZhciBOdWxsUHJvdG9PYmplY3QgPSBmdW5jdGlvbiAoKSB7XG4gIHRyeSB7XG4gICAgYWN0aXZlWERvY3VtZW50ID0gbmV3IEFjdGl2ZVhPYmplY3QoJ2h0bWxmaWxlJyk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7IC8qIGlnbm9yZSAqLyB9XG4gIE51bGxQcm90b09iamVjdCA9IHR5cGVvZiBkb2N1bWVudCAhPSAndW5kZWZpbmVkJ1xuICAgID8gZG9jdW1lbnQuZG9tYWluICYmIGFjdGl2ZVhEb2N1bWVudFxuICAgICAgPyBOdWxsUHJvdG9PYmplY3RWaWFBY3RpdmVYKGFjdGl2ZVhEb2N1bWVudCkgLy8gb2xkIElFXG4gICAgICA6IE51bGxQcm90b09iamVjdFZpYUlGcmFtZSgpXG4gICAgOiBOdWxsUHJvdG9PYmplY3RWaWFBY3RpdmVYKGFjdGl2ZVhEb2N1bWVudCk7IC8vIFdTSFxuICB2YXIgbGVuZ3RoID0gZW51bUJ1Z0tleXMubGVuZ3RoO1xuICB3aGlsZSAobGVuZ3RoLS0pIGRlbGV0ZSBOdWxsUHJvdG9PYmplY3RbUFJPVE9UWVBFXVtlbnVtQnVnS2V5c1tsZW5ndGhdXTtcbiAgcmV0dXJuIE51bGxQcm90b09iamVjdCgpO1xufTtcblxuaGlkZGVuS2V5c1tJRV9QUk9UTyQxXSA9IHRydWU7XG5cbi8vIGBPYmplY3QuY3JlYXRlYCBtZXRob2Rcbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtb2JqZWN0LmNyZWF0ZVxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tb2JqZWN0LWNyZWF0ZSAtLSBzYWZlXG52YXIgb2JqZWN0Q3JlYXRlID0gT2JqZWN0LmNyZWF0ZSB8fCBmdW5jdGlvbiBjcmVhdGUoTywgUHJvcGVydGllcykge1xuICB2YXIgcmVzdWx0O1xuICBpZiAoTyAhPT0gbnVsbCkge1xuICAgIEVtcHR5Q29uc3RydWN0b3JbUFJPVE9UWVBFXSA9IGFuT2JqZWN0JDUoTyk7XG4gICAgcmVzdWx0ID0gbmV3IEVtcHR5Q29uc3RydWN0b3IoKTtcbiAgICBFbXB0eUNvbnN0cnVjdG9yW1BST1RPVFlQRV0gPSBudWxsO1xuICAgIC8vIGFkZCBcIl9fcHJvdG9fX1wiIGZvciBPYmplY3QuZ2V0UHJvdG90eXBlT2YgcG9seWZpbGxcbiAgICByZXN1bHRbSUVfUFJPVE8kMV0gPSBPO1xuICB9IGVsc2UgcmVzdWx0ID0gTnVsbFByb3RvT2JqZWN0KCk7XG4gIHJldHVybiBQcm9wZXJ0aWVzID09PSB1bmRlZmluZWQgPyByZXN1bHQgOiBkZWZpbmVQcm9wZXJ0aWVzTW9kdWxlLmYocmVzdWx0LCBQcm9wZXJ0aWVzKTtcbn07XG5cbnZhciBmYWlscyQ5ID0gZmFpbHMkajtcbnZhciBnbG9iYWwkNCA9IGdsb2JhbCRmO1xuXG4vLyBiYWJlbC1taW5pZnkgYW5kIENsb3N1cmUgQ29tcGlsZXIgdHJhbnNwaWxlcyBSZWdFeHAoJy4nLCAncycpIC0+IC8uL3MgYW5kIGl0IGNhdXNlcyBTeW50YXhFcnJvclxudmFyICRSZWdFeHAkMSA9IGdsb2JhbCQ0LlJlZ0V4cDtcblxudmFyIHJlZ2V4cFVuc3VwcG9ydGVkRG90QWxsID0gZmFpbHMkOShmdW5jdGlvbiAoKSB7XG4gIHZhciByZSA9ICRSZWdFeHAkMSgnLicsICdzJyk7XG4gIHJldHVybiAhKHJlLmRvdEFsbCAmJiByZS5leGVjKCdcXG4nKSAmJiByZS5mbGFncyA9PT0gJ3MnKTtcbn0pO1xuXG52YXIgZmFpbHMkOCA9IGZhaWxzJGo7XG52YXIgZ2xvYmFsJDMgPSBnbG9iYWwkZjtcblxuLy8gYmFiZWwtbWluaWZ5IGFuZCBDbG9zdXJlIENvbXBpbGVyIHRyYW5zcGlsZXMgUmVnRXhwKCcoPzxhPmIpJywgJ2cnKSAtPiAvKD88YT5iKS9nIGFuZCBpdCBjYXVzZXMgU3ludGF4RXJyb3JcbnZhciAkUmVnRXhwID0gZ2xvYmFsJDMuUmVnRXhwO1xuXG52YXIgcmVnZXhwVW5zdXBwb3J0ZWROY2cgPSBmYWlscyQ4KGZ1bmN0aW9uICgpIHtcbiAgdmFyIHJlID0gJFJlZ0V4cCgnKD88YT5iKScsICdnJyk7XG4gIHJldHVybiByZS5leGVjKCdiJykuZ3JvdXBzLmEgIT09ICdiJyB8fFxuICAgICdiJy5yZXBsYWNlKHJlLCAnJDxhPmMnKSAhPT0gJ2JjJztcbn0pO1xuXG4vKiBlc2xpbnQtZGlzYWJsZSByZWdleHAvbm8tZW1wdHktY2FwdHVyaW5nLWdyb3VwLCByZWdleHAvbm8tZW1wdHktZ3JvdXAsIHJlZ2V4cC9uby1sYXp5LWVuZHMgLS0gdGVzdGluZyAqL1xuLyogZXNsaW50LWRpc2FibGUgcmVnZXhwL25vLXVzZWxlc3MtcXVhbnRpZmllciAtLSB0ZXN0aW5nICovXG52YXIgY2FsbCQ2ID0gZnVuY3Rpb25DYWxsO1xudmFyIHVuY3VycnlUaGlzJDkgPSBmdW5jdGlvblVuY3VycnlUaGlzO1xudmFyIHRvU3RyaW5nJDYgPSB0b1N0cmluZyQ3O1xudmFyIHJlZ2V4cEZsYWdzID0gcmVnZXhwRmxhZ3MkMTtcbnZhciBzdGlja3lIZWxwZXJzJDEgPSByZWdleHBTdGlja3lIZWxwZXJzO1xudmFyIHNoYXJlZCA9IHNoYXJlZCQ0LmV4cG9ydHM7XG52YXIgY3JlYXRlJDIgPSBvYmplY3RDcmVhdGU7XG52YXIgZ2V0SW50ZXJuYWxTdGF0ZSQxID0gaW50ZXJuYWxTdGF0ZS5nZXQ7XG52YXIgVU5TVVBQT1JURURfRE9UX0FMTCA9IHJlZ2V4cFVuc3VwcG9ydGVkRG90QWxsO1xudmFyIFVOU1VQUE9SVEVEX05DRyA9IHJlZ2V4cFVuc3VwcG9ydGVkTmNnO1xuXG52YXIgbmF0aXZlUmVwbGFjZSA9IHNoYXJlZCgnbmF0aXZlLXN0cmluZy1yZXBsYWNlJywgU3RyaW5nLnByb3RvdHlwZS5yZXBsYWNlKTtcbnZhciBuYXRpdmVFeGVjID0gUmVnRXhwLnByb3RvdHlwZS5leGVjO1xudmFyIHBhdGNoZWRFeGVjID0gbmF0aXZlRXhlYztcbnZhciBjaGFyQXQkMiA9IHVuY3VycnlUaGlzJDkoJycuY2hhckF0KTtcbnZhciBpbmRleE9mID0gdW5jdXJyeVRoaXMkOSgnJy5pbmRleE9mKTtcbnZhciByZXBsYWNlJDEgPSB1bmN1cnJ5VGhpcyQ5KCcnLnJlcGxhY2UpO1xudmFyIHN0cmluZ1NsaWNlJDMgPSB1bmN1cnJ5VGhpcyQ5KCcnLnNsaWNlKTtcblxudmFyIFVQREFURVNfTEFTVF9JTkRFWF9XUk9ORyA9IChmdW5jdGlvbiAoKSB7XG4gIHZhciByZTEgPSAvYS87XG4gIHZhciByZTIgPSAvYiovZztcbiAgY2FsbCQ2KG5hdGl2ZUV4ZWMsIHJlMSwgJ2EnKTtcbiAgY2FsbCQ2KG5hdGl2ZUV4ZWMsIHJlMiwgJ2EnKTtcbiAgcmV0dXJuIHJlMS5sYXN0SW5kZXggIT09IDAgfHwgcmUyLmxhc3RJbmRleCAhPT0gMDtcbn0pKCk7XG5cbnZhciBVTlNVUFBPUlRFRF9ZJDEgPSBzdGlja3lIZWxwZXJzJDEuQlJPS0VOX0NBUkVUO1xuXG4vLyBub25wYXJ0aWNpcGF0aW5nIGNhcHR1cmluZyBncm91cCwgY29waWVkIGZyb20gZXM1LXNoaW0ncyBTdHJpbmcjc3BsaXQgcGF0Y2guXG52YXIgTlBDR19JTkNMVURFRCA9IC8oKT8/Ly5leGVjKCcnKVsxXSAhPT0gdW5kZWZpbmVkO1xuXG52YXIgUEFUQ0ggPSBVUERBVEVTX0xBU1RfSU5ERVhfV1JPTkcgfHwgTlBDR19JTkNMVURFRCB8fCBVTlNVUFBPUlRFRF9ZJDEgfHwgVU5TVVBQT1JURURfRE9UX0FMTCB8fCBVTlNVUFBPUlRFRF9OQ0c7XG5cbmlmIChQQVRDSCkge1xuICBwYXRjaGVkRXhlYyA9IGZ1bmN0aW9uIGV4ZWMoc3RyaW5nKSB7XG4gICAgdmFyIHJlID0gdGhpcztcbiAgICB2YXIgc3RhdGUgPSBnZXRJbnRlcm5hbFN0YXRlJDEocmUpO1xuICAgIHZhciBzdHIgPSB0b1N0cmluZyQ2KHN0cmluZyk7XG4gICAgdmFyIHJhdyA9IHN0YXRlLnJhdztcbiAgICB2YXIgcmVzdWx0LCByZUNvcHksIGxhc3RJbmRleCwgbWF0Y2gsIGksIG9iamVjdCwgZ3JvdXA7XG5cbiAgICBpZiAocmF3KSB7XG4gICAgICByYXcubGFzdEluZGV4ID0gcmUubGFzdEluZGV4O1xuICAgICAgcmVzdWx0ID0gY2FsbCQ2KHBhdGNoZWRFeGVjLCByYXcsIHN0cik7XG4gICAgICByZS5sYXN0SW5kZXggPSByYXcubGFzdEluZGV4O1xuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICB2YXIgZ3JvdXBzID0gc3RhdGUuZ3JvdXBzO1xuICAgIHZhciBzdGlja3kgPSBVTlNVUFBPUlRFRF9ZJDEgJiYgcmUuc3RpY2t5O1xuICAgIHZhciBmbGFncyA9IGNhbGwkNihyZWdleHBGbGFncywgcmUpO1xuICAgIHZhciBzb3VyY2UgPSByZS5zb3VyY2U7XG4gICAgdmFyIGNoYXJzQWRkZWQgPSAwO1xuICAgIHZhciBzdHJDb3B5ID0gc3RyO1xuXG4gICAgaWYgKHN0aWNreSkge1xuICAgICAgZmxhZ3MgPSByZXBsYWNlJDEoZmxhZ3MsICd5JywgJycpO1xuICAgICAgaWYgKGluZGV4T2YoZmxhZ3MsICdnJykgPT09IC0xKSB7XG4gICAgICAgIGZsYWdzICs9ICdnJztcbiAgICAgIH1cblxuICAgICAgc3RyQ29weSA9IHN0cmluZ1NsaWNlJDMoc3RyLCByZS5sYXN0SW5kZXgpO1xuICAgICAgLy8gU3VwcG9ydCBhbmNob3JlZCBzdGlja3kgYmVoYXZpb3IuXG4gICAgICBpZiAocmUubGFzdEluZGV4ID4gMCAmJiAoIXJlLm11bHRpbGluZSB8fCByZS5tdWx0aWxpbmUgJiYgY2hhckF0JDIoc3RyLCByZS5sYXN0SW5kZXggLSAxKSAhPT0gJ1xcbicpKSB7XG4gICAgICAgIHNvdXJjZSA9ICcoPzogJyArIHNvdXJjZSArICcpJztcbiAgICAgICAgc3RyQ29weSA9ICcgJyArIHN0ckNvcHk7XG4gICAgICAgIGNoYXJzQWRkZWQrKztcbiAgICAgIH1cbiAgICAgIC8vIF4oPyArIHJ4ICsgKSBpcyBuZWVkZWQsIGluIGNvbWJpbmF0aW9uIHdpdGggc29tZSBzdHIgc2xpY2luZywgdG9cbiAgICAgIC8vIHNpbXVsYXRlIHRoZSAneScgZmxhZy5cbiAgICAgIHJlQ29weSA9IG5ldyBSZWdFeHAoJ14oPzonICsgc291cmNlICsgJyknLCBmbGFncyk7XG4gICAgfVxuXG4gICAgaWYgKE5QQ0dfSU5DTFVERUQpIHtcbiAgICAgIHJlQ29weSA9IG5ldyBSZWdFeHAoJ14nICsgc291cmNlICsgJyQoPyFcXFxccyknLCBmbGFncyk7XG4gICAgfVxuICAgIGlmIChVUERBVEVTX0xBU1RfSU5ERVhfV1JPTkcpIGxhc3RJbmRleCA9IHJlLmxhc3RJbmRleDtcblxuICAgIG1hdGNoID0gY2FsbCQ2KG5hdGl2ZUV4ZWMsIHN0aWNreSA/IHJlQ29weSA6IHJlLCBzdHJDb3B5KTtcblxuICAgIGlmIChzdGlja3kpIHtcbiAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICBtYXRjaC5pbnB1dCA9IHN0cmluZ1NsaWNlJDMobWF0Y2guaW5wdXQsIGNoYXJzQWRkZWQpO1xuICAgICAgICBtYXRjaFswXSA9IHN0cmluZ1NsaWNlJDMobWF0Y2hbMF0sIGNoYXJzQWRkZWQpO1xuICAgICAgICBtYXRjaC5pbmRleCA9IHJlLmxhc3RJbmRleDtcbiAgICAgICAgcmUubGFzdEluZGV4ICs9IG1hdGNoWzBdLmxlbmd0aDtcbiAgICAgIH0gZWxzZSByZS5sYXN0SW5kZXggPSAwO1xuICAgIH0gZWxzZSBpZiAoVVBEQVRFU19MQVNUX0lOREVYX1dST05HICYmIG1hdGNoKSB7XG4gICAgICByZS5sYXN0SW5kZXggPSByZS5nbG9iYWwgPyBtYXRjaC5pbmRleCArIG1hdGNoWzBdLmxlbmd0aCA6IGxhc3RJbmRleDtcbiAgICB9XG4gICAgaWYgKE5QQ0dfSU5DTFVERUQgJiYgbWF0Y2ggJiYgbWF0Y2gubGVuZ3RoID4gMSkge1xuICAgICAgLy8gRml4IGJyb3dzZXJzIHdob3NlIGBleGVjYCBtZXRob2RzIGRvbid0IGNvbnNpc3RlbnRseSByZXR1cm4gYHVuZGVmaW5lZGBcbiAgICAgIC8vIGZvciBOUENHLCBsaWtlIElFOC4gTk9URTogVGhpcyBkb2Vzbid0IHdvcmsgZm9yIC8oLj8pPy9cbiAgICAgIGNhbGwkNihuYXRpdmVSZXBsYWNlLCBtYXRjaFswXSwgcmVDb3B5LCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGZvciAoaSA9IDE7IGkgPCBhcmd1bWVudHMubGVuZ3RoIC0gMjsgaSsrKSB7XG4gICAgICAgICAgaWYgKGFyZ3VtZW50c1tpXSA9PT0gdW5kZWZpbmVkKSBtYXRjaFtpXSA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKG1hdGNoICYmIGdyb3Vwcykge1xuICAgICAgbWF0Y2guZ3JvdXBzID0gb2JqZWN0ID0gY3JlYXRlJDIobnVsbCk7XG4gICAgICBmb3IgKGkgPSAwOyBpIDwgZ3JvdXBzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGdyb3VwID0gZ3JvdXBzW2ldO1xuICAgICAgICBvYmplY3RbZ3JvdXBbMF1dID0gbWF0Y2hbZ3JvdXBbMV1dO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBtYXRjaDtcbiAgfTtcbn1cblxudmFyIHJlZ2V4cEV4ZWMkMyA9IHBhdGNoZWRFeGVjO1xuXG52YXIgJCQ0ID0gX2V4cG9ydDtcbnZhciBleGVjJDMgPSByZWdleHBFeGVjJDM7XG5cbi8vIGBSZWdFeHAucHJvdG90eXBlLmV4ZWNgIG1ldGhvZFxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1yZWdleHAucHJvdG90eXBlLmV4ZWNcbiQkNCh7IHRhcmdldDogJ1JlZ0V4cCcsIHByb3RvOiB0cnVlLCBmb3JjZWQ6IC8uLy5leGVjICE9PSBleGVjJDMgfSwge1xuICBleGVjOiBleGVjJDNcbn0pO1xuXG52YXIgTkFUSVZFX0JJTkQgPSBmdW5jdGlvbkJpbmROYXRpdmU7XG5cbnZhciBGdW5jdGlvblByb3RvdHlwZSA9IEZ1bmN0aW9uLnByb3RvdHlwZTtcbnZhciBhcHBseSQxID0gRnVuY3Rpb25Qcm90b3R5cGUuYXBwbHk7XG52YXIgY2FsbCQ1ID0gRnVuY3Rpb25Qcm90b3R5cGUuY2FsbDtcblxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tcmVmbGVjdCAtLSBzYWZlXG52YXIgZnVuY3Rpb25BcHBseSA9IHR5cGVvZiBSZWZsZWN0ID09ICdvYmplY3QnICYmIFJlZmxlY3QuYXBwbHkgfHwgKE5BVElWRV9CSU5EID8gY2FsbCQ1LmJpbmQoYXBwbHkkMSkgOiBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiBjYWxsJDUuYXBwbHkoYXBwbHkkMSwgYXJndW1lbnRzKTtcbn0pO1xuXG4vLyBUT0RPOiBSZW1vdmUgZnJvbSBgY29yZS1qc0A0YCBzaW5jZSBpdCdzIG1vdmVkIHRvIGVudHJ5IHBvaW50c1xuXG52YXIgdW5jdXJyeVRoaXMkOCA9IGZ1bmN0aW9uVW5jdXJyeVRoaXM7XG52YXIgZGVmaW5lQnVpbHRJbiQzID0gZGVmaW5lQnVpbHRJbiQ1O1xudmFyIHJlZ2V4cEV4ZWMkMiA9IHJlZ2V4cEV4ZWMkMztcbnZhciBmYWlscyQ3ID0gZmFpbHMkajtcbnZhciB3ZWxsS25vd25TeW1ib2wkNyA9IHdlbGxLbm93blN5bWJvbCRiO1xudmFyIGNyZWF0ZU5vbkVudW1lcmFibGVQcm9wZXJ0eSQyID0gY3JlYXRlTm9uRW51bWVyYWJsZVByb3BlcnR5JDU7XG5cbnZhciBTUEVDSUVTJDEgPSB3ZWxsS25vd25TeW1ib2wkNygnc3BlY2llcycpO1xudmFyIFJlZ0V4cFByb3RvdHlwZSQyID0gUmVnRXhwLnByb3RvdHlwZTtcblxudmFyIGZpeFJlZ2V4cFdlbGxLbm93blN5bWJvbExvZ2ljID0gZnVuY3Rpb24gKEtFWSwgZXhlYywgRk9SQ0VELCBTSEFNKSB7XG4gIHZhciBTWU1CT0wgPSB3ZWxsS25vd25TeW1ib2wkNyhLRVkpO1xuXG4gIHZhciBERUxFR0FURVNfVE9fU1lNQk9MID0gIWZhaWxzJDcoZnVuY3Rpb24gKCkge1xuICAgIC8vIFN0cmluZyBtZXRob2RzIGNhbGwgc3ltYm9sLW5hbWVkIFJlZ0VwIG1ldGhvZHNcbiAgICB2YXIgTyA9IHt9O1xuICAgIE9bU1lNQk9MXSA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuIDc7IH07XG4gICAgcmV0dXJuICcnW0tFWV0oTykgIT0gNztcbiAgfSk7XG5cbiAgdmFyIERFTEVHQVRFU19UT19FWEVDID0gREVMRUdBVEVTX1RPX1NZTUJPTCAmJiAhZmFpbHMkNyhmdW5jdGlvbiAoKSB7XG4gICAgLy8gU3ltYm9sLW5hbWVkIFJlZ0V4cCBtZXRob2RzIGNhbGwgLmV4ZWNcbiAgICB2YXIgZXhlY0NhbGxlZCA9IGZhbHNlO1xuICAgIHZhciByZSA9IC9hLztcblxuICAgIGlmIChLRVkgPT09ICdzcGxpdCcpIHtcbiAgICAgIC8vIFdlIGNhbid0IHVzZSByZWFsIHJlZ2V4IGhlcmUgc2luY2UgaXQgY2F1c2VzIGRlb3B0aW1pemF0aW9uXG4gICAgICAvLyBhbmQgc2VyaW91cyBwZXJmb3JtYW5jZSBkZWdyYWRhdGlvbiBpbiBWOFxuICAgICAgLy8gaHR0cHM6Ly9naXRodWIuY29tL3psb2lyb2NrL2NvcmUtanMvaXNzdWVzLzMwNlxuICAgICAgcmUgPSB7fTtcbiAgICAgIC8vIFJlZ0V4cFtAQHNwbGl0XSBkb2Vzbid0IGNhbGwgdGhlIHJlZ2V4J3MgZXhlYyBtZXRob2QsIGJ1dCBmaXJzdCBjcmVhdGVzXG4gICAgICAvLyBhIG5ldyBvbmUuIFdlIG5lZWQgdG8gcmV0dXJuIHRoZSBwYXRjaGVkIHJlZ2V4IHdoZW4gY3JlYXRpbmcgdGhlIG5ldyBvbmUuXG4gICAgICByZS5jb25zdHJ1Y3RvciA9IHt9O1xuICAgICAgcmUuY29uc3RydWN0b3JbU1BFQ0lFUyQxXSA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuIHJlOyB9O1xuICAgICAgcmUuZmxhZ3MgPSAnJztcbiAgICAgIHJlW1NZTUJPTF0gPSAvLi9bU1lNQk9MXTtcbiAgICB9XG5cbiAgICByZS5leGVjID0gZnVuY3Rpb24gKCkgeyBleGVjQ2FsbGVkID0gdHJ1ZTsgcmV0dXJuIG51bGw7IH07XG5cbiAgICByZVtTWU1CT0xdKCcnKTtcbiAgICByZXR1cm4gIWV4ZWNDYWxsZWQ7XG4gIH0pO1xuXG4gIGlmIChcbiAgICAhREVMRUdBVEVTX1RPX1NZTUJPTCB8fFxuICAgICFERUxFR0FURVNfVE9fRVhFQyB8fFxuICAgIEZPUkNFRFxuICApIHtcbiAgICB2YXIgdW5jdXJyaWVkTmF0aXZlUmVnRXhwTWV0aG9kID0gdW5jdXJyeVRoaXMkOCgvLi9bU1lNQk9MXSk7XG4gICAgdmFyIG1ldGhvZHMgPSBleGVjKFNZTUJPTCwgJydbS0VZXSwgZnVuY3Rpb24gKG5hdGl2ZU1ldGhvZCwgcmVnZXhwLCBzdHIsIGFyZzIsIGZvcmNlU3RyaW5nTWV0aG9kKSB7XG4gICAgICB2YXIgdW5jdXJyaWVkTmF0aXZlTWV0aG9kID0gdW5jdXJyeVRoaXMkOChuYXRpdmVNZXRob2QpO1xuICAgICAgdmFyICRleGVjID0gcmVnZXhwLmV4ZWM7XG4gICAgICBpZiAoJGV4ZWMgPT09IHJlZ2V4cEV4ZWMkMiB8fCAkZXhlYyA9PT0gUmVnRXhwUHJvdG90eXBlJDIuZXhlYykge1xuICAgICAgICBpZiAoREVMRUdBVEVTX1RPX1NZTUJPTCAmJiAhZm9yY2VTdHJpbmdNZXRob2QpIHtcbiAgICAgICAgICAvLyBUaGUgbmF0aXZlIFN0cmluZyBtZXRob2QgYWxyZWFkeSBkZWxlZ2F0ZXMgdG8gQEBtZXRob2QgKHRoaXNcbiAgICAgICAgICAvLyBwb2x5ZmlsbGVkIGZ1bmN0aW9uKSwgbGVhc2luZyB0byBpbmZpbml0ZSByZWN1cnNpb24uXG4gICAgICAgICAgLy8gV2UgYXZvaWQgaXQgYnkgZGlyZWN0bHkgY2FsbGluZyB0aGUgbmF0aXZlIEBAbWV0aG9kIG1ldGhvZC5cbiAgICAgICAgICByZXR1cm4geyBkb25lOiB0cnVlLCB2YWx1ZTogdW5jdXJyaWVkTmF0aXZlUmVnRXhwTWV0aG9kKHJlZ2V4cCwgc3RyLCBhcmcyKSB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IGRvbmU6IHRydWUsIHZhbHVlOiB1bmN1cnJpZWROYXRpdmVNZXRob2Qoc3RyLCByZWdleHAsIGFyZzIpIH07XG4gICAgICB9XG4gICAgICByZXR1cm4geyBkb25lOiBmYWxzZSB9O1xuICAgIH0pO1xuXG4gICAgZGVmaW5lQnVpbHRJbiQzKFN0cmluZy5wcm90b3R5cGUsIEtFWSwgbWV0aG9kc1swXSk7XG4gICAgZGVmaW5lQnVpbHRJbiQzKFJlZ0V4cFByb3RvdHlwZSQyLCBTWU1CT0wsIG1ldGhvZHNbMV0pO1xuICB9XG5cbiAgaWYgKFNIQU0pIGNyZWF0ZU5vbkVudW1lcmFibGVQcm9wZXJ0eSQyKFJlZ0V4cFByb3RvdHlwZSQyW1NZTUJPTF0sICdzaGFtJywgdHJ1ZSk7XG59O1xuXG52YXIgaXNPYmplY3QgPSBpc09iamVjdCQ2O1xudmFyIGNsYXNzb2YkMiA9IGNsYXNzb2ZSYXckMTtcbnZhciB3ZWxsS25vd25TeW1ib2wkNiA9IHdlbGxLbm93blN5bWJvbCRiO1xuXG52YXIgTUFUQ0ggPSB3ZWxsS25vd25TeW1ib2wkNignbWF0Y2gnKTtcblxuLy8gYElzUmVnRXhwYCBhYnN0cmFjdCBvcGVyYXRpb25cbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtaXNyZWdleHBcbnZhciBpc1JlZ2V4cCA9IGZ1bmN0aW9uIChpdCkge1xuICB2YXIgaXNSZWdFeHA7XG4gIHJldHVybiBpc09iamVjdChpdCkgJiYgKChpc1JlZ0V4cCA9IGl0W01BVENIXSkgIT09IHVuZGVmaW5lZCA/ICEhaXNSZWdFeHAgOiBjbGFzc29mJDIoaXQpID09ICdSZWdFeHAnKTtcbn07XG5cbnZhciB1bmN1cnJ5VGhpcyQ3ID0gZnVuY3Rpb25VbmN1cnJ5VGhpcztcbnZhciBmYWlscyQ2ID0gZmFpbHMkajtcbnZhciBpc0NhbGxhYmxlJDUgPSBpc0NhbGxhYmxlJGg7XG52YXIgY2xhc3NvZiQxID0gY2xhc3NvZiQ0O1xudmFyIGdldEJ1aWx0SW4gPSBnZXRCdWlsdEluJDU7XG52YXIgaW5zcGVjdFNvdXJjZSA9IGluc3BlY3RTb3VyY2UkMztcblxudmFyIG5vb3AgPSBmdW5jdGlvbiAoKSB7IC8qIGVtcHR5ICovIH07XG52YXIgZW1wdHkgPSBbXTtcbnZhciBjb25zdHJ1Y3QgPSBnZXRCdWlsdEluKCdSZWZsZWN0JywgJ2NvbnN0cnVjdCcpO1xudmFyIGNvbnN0cnVjdG9yUmVnRXhwID0gL15cXHMqKD86Y2xhc3N8ZnVuY3Rpb24pXFxiLztcbnZhciBleGVjJDIgPSB1bmN1cnJ5VGhpcyQ3KGNvbnN0cnVjdG9yUmVnRXhwLmV4ZWMpO1xudmFyIElOQ09SUkVDVF9UT19TVFJJTkcgPSAhY29uc3RydWN0b3JSZWdFeHAuZXhlYyhub29wKTtcblxudmFyIGlzQ29uc3RydWN0b3JNb2Rlcm4gPSBmdW5jdGlvbiBpc0NvbnN0cnVjdG9yKGFyZ3VtZW50KSB7XG4gIGlmICghaXNDYWxsYWJsZSQ1KGFyZ3VtZW50KSkgcmV0dXJuIGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0cnVjdChub29wLCBlbXB0eSwgYXJndW1lbnQpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufTtcblxudmFyIGlzQ29uc3RydWN0b3JMZWdhY3kgPSBmdW5jdGlvbiBpc0NvbnN0cnVjdG9yKGFyZ3VtZW50KSB7XG4gIGlmICghaXNDYWxsYWJsZSQ1KGFyZ3VtZW50KSkgcmV0dXJuIGZhbHNlO1xuICBzd2l0Y2ggKGNsYXNzb2YkMShhcmd1bWVudCkpIHtcbiAgICBjYXNlICdBc3luY0Z1bmN0aW9uJzpcbiAgICBjYXNlICdHZW5lcmF0b3JGdW5jdGlvbic6XG4gICAgY2FzZSAnQXN5bmNHZW5lcmF0b3JGdW5jdGlvbic6IHJldHVybiBmYWxzZTtcbiAgfVxuICB0cnkge1xuICAgIC8vIHdlIGNhbid0IGNoZWNrIC5wcm90b3R5cGUgc2luY2UgY29uc3RydWN0b3JzIHByb2R1Y2VkIGJ5IC5iaW5kIGhhdmVuJ3QgaXRcbiAgICAvLyBgRnVuY3Rpb24jdG9TdHJpbmdgIHRocm93cyBvbiBzb21lIGJ1aWx0LWl0IGZ1bmN0aW9uIGluIHNvbWUgbGVnYWN5IGVuZ2luZXNcbiAgICAvLyAoZm9yIGV4YW1wbGUsIGBET01RdWFkYCBhbmQgc2ltaWxhciBpbiBGRjQxLSlcbiAgICByZXR1cm4gSU5DT1JSRUNUX1RPX1NUUklORyB8fCAhIWV4ZWMkMihjb25zdHJ1Y3RvclJlZ0V4cCwgaW5zcGVjdFNvdXJjZShhcmd1bWVudCkpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG59O1xuXG5pc0NvbnN0cnVjdG9yTGVnYWN5LnNoYW0gPSB0cnVlO1xuXG4vLyBgSXNDb25zdHJ1Y3RvcmAgYWJzdHJhY3Qgb3BlcmF0aW9uXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLWlzY29uc3RydWN0b3JcbnZhciBpc0NvbnN0cnVjdG9yJDEgPSAhY29uc3RydWN0IHx8IGZhaWxzJDYoZnVuY3Rpb24gKCkge1xuICB2YXIgY2FsbGVkO1xuICByZXR1cm4gaXNDb25zdHJ1Y3Rvck1vZGVybihpc0NvbnN0cnVjdG9yTW9kZXJuLmNhbGwpXG4gICAgfHwgIWlzQ29uc3RydWN0b3JNb2Rlcm4oT2JqZWN0KVxuICAgIHx8ICFpc0NvbnN0cnVjdG9yTW9kZXJuKGZ1bmN0aW9uICgpIHsgY2FsbGVkID0gdHJ1ZTsgfSlcbiAgICB8fCBjYWxsZWQ7XG59KSA/IGlzQ29uc3RydWN0b3JMZWdhY3kgOiBpc0NvbnN0cnVjdG9yTW9kZXJuO1xuXG52YXIgaXNDb25zdHJ1Y3RvciA9IGlzQ29uc3RydWN0b3IkMTtcbnZhciB0cnlUb1N0cmluZyA9IHRyeVRvU3RyaW5nJDI7XG5cbnZhciAkVHlwZUVycm9yJDIgPSBUeXBlRXJyb3I7XG5cbi8vIGBBc3NlcnQ6IElzQ29uc3RydWN0b3IoYXJndW1lbnQpIGlzIHRydWVgXG52YXIgYUNvbnN0cnVjdG9yJDEgPSBmdW5jdGlvbiAoYXJndW1lbnQpIHtcbiAgaWYgKGlzQ29uc3RydWN0b3IoYXJndW1lbnQpKSByZXR1cm4gYXJndW1lbnQ7XG4gIHRocm93ICRUeXBlRXJyb3IkMih0cnlUb1N0cmluZyhhcmd1bWVudCkgKyAnIGlzIG5vdCBhIGNvbnN0cnVjdG9yJyk7XG59O1xuXG52YXIgYW5PYmplY3QkNCA9IGFuT2JqZWN0JGE7XG52YXIgYUNvbnN0cnVjdG9yID0gYUNvbnN0cnVjdG9yJDE7XG52YXIgd2VsbEtub3duU3ltYm9sJDUgPSB3ZWxsS25vd25TeW1ib2wkYjtcblxudmFyIFNQRUNJRVMgPSB3ZWxsS25vd25TeW1ib2wkNSgnc3BlY2llcycpO1xuXG4vLyBgU3BlY2llc0NvbnN0cnVjdG9yYCBhYnN0cmFjdCBvcGVyYXRpb25cbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtc3BlY2llc2NvbnN0cnVjdG9yXG52YXIgc3BlY2llc0NvbnN0cnVjdG9yJDEgPSBmdW5jdGlvbiAoTywgZGVmYXVsdENvbnN0cnVjdG9yKSB7XG4gIHZhciBDID0gYW5PYmplY3QkNChPKS5jb25zdHJ1Y3RvcjtcbiAgdmFyIFM7XG4gIHJldHVybiBDID09PSB1bmRlZmluZWQgfHwgKFMgPSBhbk9iamVjdCQ0KEMpW1NQRUNJRVNdKSA9PSB1bmRlZmluZWQgPyBkZWZhdWx0Q29uc3RydWN0b3IgOiBhQ29uc3RydWN0b3IoUyk7XG59O1xuXG52YXIgdW5jdXJyeVRoaXMkNiA9IGZ1bmN0aW9uVW5jdXJyeVRoaXM7XG52YXIgdG9JbnRlZ2VyT3JJbmZpbml0eSQxID0gdG9JbnRlZ2VyT3JJbmZpbml0eSQ0O1xudmFyIHRvU3RyaW5nJDUgPSB0b1N0cmluZyQ3O1xudmFyIHJlcXVpcmVPYmplY3RDb2VyY2libGUkNCA9IHJlcXVpcmVPYmplY3RDb2VyY2libGUkNztcblxudmFyIGNoYXJBdCQxID0gdW5jdXJyeVRoaXMkNignJy5jaGFyQXQpO1xudmFyIGNoYXJDb2RlQXQgPSB1bmN1cnJ5VGhpcyQ2KCcnLmNoYXJDb2RlQXQpO1xudmFyIHN0cmluZ1NsaWNlJDIgPSB1bmN1cnJ5VGhpcyQ2KCcnLnNsaWNlKTtcblxudmFyIGNyZWF0ZU1ldGhvZCQyID0gZnVuY3Rpb24gKENPTlZFUlRfVE9fU1RSSU5HKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoJHRoaXMsIHBvcykge1xuICAgIHZhciBTID0gdG9TdHJpbmckNShyZXF1aXJlT2JqZWN0Q29lcmNpYmxlJDQoJHRoaXMpKTtcbiAgICB2YXIgcG9zaXRpb24gPSB0b0ludGVnZXJPckluZmluaXR5JDEocG9zKTtcbiAgICB2YXIgc2l6ZSA9IFMubGVuZ3RoO1xuICAgIHZhciBmaXJzdCwgc2Vjb25kO1xuICAgIGlmIChwb3NpdGlvbiA8IDAgfHwgcG9zaXRpb24gPj0gc2l6ZSkgcmV0dXJuIENPTlZFUlRfVE9fU1RSSU5HID8gJycgOiB1bmRlZmluZWQ7XG4gICAgZmlyc3QgPSBjaGFyQ29kZUF0KFMsIHBvc2l0aW9uKTtcbiAgICByZXR1cm4gZmlyc3QgPCAweEQ4MDAgfHwgZmlyc3QgPiAweERCRkYgfHwgcG9zaXRpb24gKyAxID09PSBzaXplXG4gICAgICB8fCAoc2Vjb25kID0gY2hhckNvZGVBdChTLCBwb3NpdGlvbiArIDEpKSA8IDB4REMwMCB8fCBzZWNvbmQgPiAweERGRkZcbiAgICAgICAgPyBDT05WRVJUX1RPX1NUUklOR1xuICAgICAgICAgID8gY2hhckF0JDEoUywgcG9zaXRpb24pXG4gICAgICAgICAgOiBmaXJzdFxuICAgICAgICA6IENPTlZFUlRfVE9fU1RSSU5HXG4gICAgICAgICAgPyBzdHJpbmdTbGljZSQyKFMsIHBvc2l0aW9uLCBwb3NpdGlvbiArIDIpXG4gICAgICAgICAgOiAoZmlyc3QgLSAweEQ4MDAgPDwgMTApICsgKHNlY29uZCAtIDB4REMwMCkgKyAweDEwMDAwO1xuICB9O1xufTtcblxudmFyIHN0cmluZ011bHRpYnl0ZSA9IHtcbiAgLy8gYFN0cmluZy5wcm90b3R5cGUuY29kZVBvaW50QXRgIG1ldGhvZFxuICAvLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLXN0cmluZy5wcm90b3R5cGUuY29kZXBvaW50YXRcbiAgY29kZUF0OiBjcmVhdGVNZXRob2QkMihmYWxzZSksXG4gIC8vIGBTdHJpbmcucHJvdG90eXBlLmF0YCBtZXRob2RcbiAgLy8gaHR0cHM6Ly9naXRodWIuY29tL21hdGhpYXNieW5lbnMvU3RyaW5nLnByb3RvdHlwZS5hdFxuICBjaGFyQXQ6IGNyZWF0ZU1ldGhvZCQyKHRydWUpXG59O1xuXG52YXIgY2hhckF0ID0gc3RyaW5nTXVsdGlieXRlLmNoYXJBdDtcblxuLy8gYEFkdmFuY2VTdHJpbmdJbmRleGAgYWJzdHJhY3Qgb3BlcmF0aW9uXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLWFkdmFuY2VzdHJpbmdpbmRleFxudmFyIGFkdmFuY2VTdHJpbmdJbmRleCQxID0gZnVuY3Rpb24gKFMsIGluZGV4LCB1bmljb2RlKSB7XG4gIHJldHVybiBpbmRleCArICh1bmljb2RlID8gY2hhckF0KFMsIGluZGV4KS5sZW5ndGggOiAxKTtcbn07XG5cbnZhciB0b1Byb3BlcnR5S2V5ID0gdG9Qcm9wZXJ0eUtleSQzO1xudmFyIGRlZmluZVByb3BlcnR5TW9kdWxlID0gb2JqZWN0RGVmaW5lUHJvcGVydHk7XG52YXIgY3JlYXRlUHJvcGVydHlEZXNjcmlwdG9yJDEgPSBjcmVhdGVQcm9wZXJ0eURlc2NyaXB0b3IkNDtcblxudmFyIGNyZWF0ZVByb3BlcnR5JDEgPSBmdW5jdGlvbiAob2JqZWN0LCBrZXksIHZhbHVlKSB7XG4gIHZhciBwcm9wZXJ0eUtleSA9IHRvUHJvcGVydHlLZXkoa2V5KTtcbiAgaWYgKHByb3BlcnR5S2V5IGluIG9iamVjdCkgZGVmaW5lUHJvcGVydHlNb2R1bGUuZihvYmplY3QsIHByb3BlcnR5S2V5LCBjcmVhdGVQcm9wZXJ0eURlc2NyaXB0b3IkMSgwLCB2YWx1ZSkpO1xuICBlbHNlIG9iamVjdFtwcm9wZXJ0eUtleV0gPSB2YWx1ZTtcbn07XG5cbnZhciB0b0Fic29sdXRlSW5kZXggPSB0b0Fic29sdXRlSW5kZXgkMjtcbnZhciBsZW5ndGhPZkFycmF5TGlrZSA9IGxlbmd0aE9mQXJyYXlMaWtlJDI7XG52YXIgY3JlYXRlUHJvcGVydHkgPSBjcmVhdGVQcm9wZXJ0eSQxO1xuXG52YXIgJEFycmF5ID0gQXJyYXk7XG52YXIgbWF4ID0gTWF0aC5tYXg7XG5cbnZhciBhcnJheVNsaWNlU2ltcGxlID0gZnVuY3Rpb24gKE8sIHN0YXJ0LCBlbmQpIHtcbiAgdmFyIGxlbmd0aCA9IGxlbmd0aE9mQXJyYXlMaWtlKE8pO1xuICB2YXIgayA9IHRvQWJzb2x1dGVJbmRleChzdGFydCwgbGVuZ3RoKTtcbiAgdmFyIGZpbiA9IHRvQWJzb2x1dGVJbmRleChlbmQgPT09IHVuZGVmaW5lZCA/IGxlbmd0aCA6IGVuZCwgbGVuZ3RoKTtcbiAgdmFyIHJlc3VsdCA9ICRBcnJheShtYXgoZmluIC0gaywgMCkpO1xuICBmb3IgKHZhciBuID0gMDsgayA8IGZpbjsgaysrLCBuKyspIGNyZWF0ZVByb3BlcnR5KHJlc3VsdCwgbiwgT1trXSk7XG4gIHJlc3VsdC5sZW5ndGggPSBuO1xuICByZXR1cm4gcmVzdWx0O1xufTtcblxudmFyIGNhbGwkNCA9IGZ1bmN0aW9uQ2FsbDtcbnZhciBhbk9iamVjdCQzID0gYW5PYmplY3QkYTtcbnZhciBpc0NhbGxhYmxlJDQgPSBpc0NhbGxhYmxlJGg7XG52YXIgY2xhc3NvZiA9IGNsYXNzb2ZSYXckMTtcbnZhciByZWdleHBFeGVjJDEgPSByZWdleHBFeGVjJDM7XG5cbnZhciAkVHlwZUVycm9yJDEgPSBUeXBlRXJyb3I7XG5cbi8vIGBSZWdFeHBFeGVjYCBhYnN0cmFjdCBvcGVyYXRpb25cbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtcmVnZXhwZXhlY1xudmFyIHJlZ2V4cEV4ZWNBYnN0cmFjdCA9IGZ1bmN0aW9uIChSLCBTKSB7XG4gIHZhciBleGVjID0gUi5leGVjO1xuICBpZiAoaXNDYWxsYWJsZSQ0KGV4ZWMpKSB7XG4gICAgdmFyIHJlc3VsdCA9IGNhbGwkNChleGVjLCBSLCBTKTtcbiAgICBpZiAocmVzdWx0ICE9PSBudWxsKSBhbk9iamVjdCQzKHJlc3VsdCk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuICBpZiAoY2xhc3NvZihSKSA9PT0gJ1JlZ0V4cCcpIHJldHVybiBjYWxsJDQocmVnZXhwRXhlYyQxLCBSLCBTKTtcbiAgdGhyb3cgJFR5cGVFcnJvciQxKCdSZWdFeHAjZXhlYyBjYWxsZWQgb24gaW5jb21wYXRpYmxlIHJlY2VpdmVyJyk7XG59O1xuXG52YXIgYXBwbHkgPSBmdW5jdGlvbkFwcGx5O1xudmFyIGNhbGwkMyA9IGZ1bmN0aW9uQ2FsbDtcbnZhciB1bmN1cnJ5VGhpcyQ1ID0gZnVuY3Rpb25VbmN1cnJ5VGhpcztcbnZhciBmaXhSZWdFeHBXZWxsS25vd25TeW1ib2xMb2dpYyA9IGZpeFJlZ2V4cFdlbGxLbm93blN5bWJvbExvZ2ljO1xudmFyIGlzUmVnRXhwID0gaXNSZWdleHA7XG52YXIgYW5PYmplY3QkMiA9IGFuT2JqZWN0JGE7XG52YXIgcmVxdWlyZU9iamVjdENvZXJjaWJsZSQzID0gcmVxdWlyZU9iamVjdENvZXJjaWJsZSQ3O1xudmFyIHNwZWNpZXNDb25zdHJ1Y3RvciA9IHNwZWNpZXNDb25zdHJ1Y3RvciQxO1xudmFyIGFkdmFuY2VTdHJpbmdJbmRleCA9IGFkdmFuY2VTdHJpbmdJbmRleCQxO1xudmFyIHRvTGVuZ3RoJDEgPSB0b0xlbmd0aCQzO1xudmFyIHRvU3RyaW5nJDQgPSB0b1N0cmluZyQ3O1xudmFyIGdldE1ldGhvZCA9IGdldE1ldGhvZCQyO1xudmFyIGFycmF5U2xpY2UgPSBhcnJheVNsaWNlU2ltcGxlO1xudmFyIGNhbGxSZWdFeHBFeGVjID0gcmVnZXhwRXhlY0Fic3RyYWN0O1xudmFyIHJlZ2V4cEV4ZWMgPSByZWdleHBFeGVjJDM7XG52YXIgc3RpY2t5SGVscGVycyA9IHJlZ2V4cFN0aWNreUhlbHBlcnM7XG52YXIgZmFpbHMkNSA9IGZhaWxzJGo7XG5cbnZhciBVTlNVUFBPUlRFRF9ZID0gc3RpY2t5SGVscGVycy5VTlNVUFBPUlRFRF9ZO1xudmFyIE1BWF9VSU5UMzIgPSAweEZGRkZGRkZGO1xudmFyIG1pbiA9IE1hdGgubWluO1xudmFyICRwdXNoID0gW10ucHVzaDtcbnZhciBleGVjJDEgPSB1bmN1cnJ5VGhpcyQ1KC8uLy5leGVjKTtcbnZhciBwdXNoID0gdW5jdXJyeVRoaXMkNSgkcHVzaCk7XG52YXIgc3RyaW5nU2xpY2UkMSA9IHVuY3VycnlUaGlzJDUoJycuc2xpY2UpO1xuXG4vLyBDaHJvbWUgNTEgaGFzIGEgYnVnZ3kgXCJzcGxpdFwiIGltcGxlbWVudGF0aW9uIHdoZW4gUmVnRXhwI2V4ZWMgIT09IG5hdGl2ZUV4ZWNcbi8vIFdlZXggSlMgaGFzIGZyb3plbiBidWlsdC1pbiBwcm90b3R5cGVzLCBzbyB1c2UgdHJ5IC8gY2F0Y2ggd3JhcHBlclxudmFyIFNQTElUX1dPUktTX1dJVEhfT1ZFUldSSVRURU5fRVhFQyA9ICFmYWlscyQ1KGZ1bmN0aW9uICgpIHtcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIHJlZ2V4cC9uby1lbXB0eS1ncm91cCAtLSByZXF1aXJlZCBmb3IgdGVzdGluZ1xuICB2YXIgcmUgPSAvKD86KS87XG4gIHZhciBvcmlnaW5hbEV4ZWMgPSByZS5leGVjO1xuICByZS5leGVjID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gb3JpZ2luYWxFeGVjLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7IH07XG4gIHZhciByZXN1bHQgPSAnYWInLnNwbGl0KHJlKTtcbiAgcmV0dXJuIHJlc3VsdC5sZW5ndGggIT09IDIgfHwgcmVzdWx0WzBdICE9PSAnYScgfHwgcmVzdWx0WzFdICE9PSAnYic7XG59KTtcblxuLy8gQEBzcGxpdCBsb2dpY1xuZml4UmVnRXhwV2VsbEtub3duU3ltYm9sTG9naWMoJ3NwbGl0JywgZnVuY3Rpb24gKFNQTElULCBuYXRpdmVTcGxpdCwgbWF5YmVDYWxsTmF0aXZlKSB7XG4gIHZhciBpbnRlcm5hbFNwbGl0O1xuICBpZiAoXG4gICAgJ2FiYmMnLnNwbGl0KC8oYikqLylbMV0gPT0gJ2MnIHx8XG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIHJlZ2V4cC9uby1lbXB0eS1ncm91cCAtLSByZXF1aXJlZCBmb3IgdGVzdGluZ1xuICAgICd0ZXN0Jy5zcGxpdCgvKD86KS8sIC0xKS5sZW5ndGggIT0gNCB8fFxuICAgICdhYicuc3BsaXQoLyg/OmFiKSovKS5sZW5ndGggIT0gMiB8fFxuICAgICcuJy5zcGxpdCgvKC4/KSguPykvKS5sZW5ndGggIT0gNCB8fFxuICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSByZWdleHAvbm8tZW1wdHktY2FwdHVyaW5nLWdyb3VwLCByZWdleHAvbm8tZW1wdHktZ3JvdXAgLS0gcmVxdWlyZWQgZm9yIHRlc3RpbmdcbiAgICAnLicuc3BsaXQoLygpKCkvKS5sZW5ndGggPiAxIHx8XG4gICAgJycuc3BsaXQoLy4/LykubGVuZ3RoXG4gICkge1xuICAgIC8vIGJhc2VkIG9uIGVzNS1zaGltIGltcGxlbWVudGF0aW9uLCBuZWVkIHRvIHJld29yayBpdFxuICAgIGludGVybmFsU3BsaXQgPSBmdW5jdGlvbiAoc2VwYXJhdG9yLCBsaW1pdCkge1xuICAgICAgdmFyIHN0cmluZyA9IHRvU3RyaW5nJDQocmVxdWlyZU9iamVjdENvZXJjaWJsZSQzKHRoaXMpKTtcbiAgICAgIHZhciBsaW0gPSBsaW1pdCA9PT0gdW5kZWZpbmVkID8gTUFYX1VJTlQzMiA6IGxpbWl0ID4+PiAwO1xuICAgICAgaWYgKGxpbSA9PT0gMCkgcmV0dXJuIFtdO1xuICAgICAgaWYgKHNlcGFyYXRvciA9PT0gdW5kZWZpbmVkKSByZXR1cm4gW3N0cmluZ107XG4gICAgICAvLyBJZiBgc2VwYXJhdG9yYCBpcyBub3QgYSByZWdleCwgdXNlIG5hdGl2ZSBzcGxpdFxuICAgICAgaWYgKCFpc1JlZ0V4cChzZXBhcmF0b3IpKSB7XG4gICAgICAgIHJldHVybiBjYWxsJDMobmF0aXZlU3BsaXQsIHN0cmluZywgc2VwYXJhdG9yLCBsaW0pO1xuICAgICAgfVxuICAgICAgdmFyIG91dHB1dCA9IFtdO1xuICAgICAgdmFyIGZsYWdzID0gKHNlcGFyYXRvci5pZ25vcmVDYXNlID8gJ2knIDogJycpICtcbiAgICAgICAgICAgICAgICAgIChzZXBhcmF0b3IubXVsdGlsaW5lID8gJ20nIDogJycpICtcbiAgICAgICAgICAgICAgICAgIChzZXBhcmF0b3IudW5pY29kZSA/ICd1JyA6ICcnKSArXG4gICAgICAgICAgICAgICAgICAoc2VwYXJhdG9yLnN0aWNreSA/ICd5JyA6ICcnKTtcbiAgICAgIHZhciBsYXN0TGFzdEluZGV4ID0gMDtcbiAgICAgIC8vIE1ha2UgYGdsb2JhbGAgYW5kIGF2b2lkIGBsYXN0SW5kZXhgIGlzc3VlcyBieSB3b3JraW5nIHdpdGggYSBjb3B5XG4gICAgICB2YXIgc2VwYXJhdG9yQ29weSA9IG5ldyBSZWdFeHAoc2VwYXJhdG9yLnNvdXJjZSwgZmxhZ3MgKyAnZycpO1xuICAgICAgdmFyIG1hdGNoLCBsYXN0SW5kZXgsIGxhc3RMZW5ndGg7XG4gICAgICB3aGlsZSAobWF0Y2ggPSBjYWxsJDMocmVnZXhwRXhlYywgc2VwYXJhdG9yQ29weSwgc3RyaW5nKSkge1xuICAgICAgICBsYXN0SW5kZXggPSBzZXBhcmF0b3JDb3B5Lmxhc3RJbmRleDtcbiAgICAgICAgaWYgKGxhc3RJbmRleCA+IGxhc3RMYXN0SW5kZXgpIHtcbiAgICAgICAgICBwdXNoKG91dHB1dCwgc3RyaW5nU2xpY2UkMShzdHJpbmcsIGxhc3RMYXN0SW5kZXgsIG1hdGNoLmluZGV4KSk7XG4gICAgICAgICAgaWYgKG1hdGNoLmxlbmd0aCA+IDEgJiYgbWF0Y2guaW5kZXggPCBzdHJpbmcubGVuZ3RoKSBhcHBseSgkcHVzaCwgb3V0cHV0LCBhcnJheVNsaWNlKG1hdGNoLCAxKSk7XG4gICAgICAgICAgbGFzdExlbmd0aCA9IG1hdGNoWzBdLmxlbmd0aDtcbiAgICAgICAgICBsYXN0TGFzdEluZGV4ID0gbGFzdEluZGV4O1xuICAgICAgICAgIGlmIChvdXRwdXQubGVuZ3RoID49IGxpbSkgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHNlcGFyYXRvckNvcHkubGFzdEluZGV4ID09PSBtYXRjaC5pbmRleCkgc2VwYXJhdG9yQ29weS5sYXN0SW5kZXgrKzsgLy8gQXZvaWQgYW4gaW5maW5pdGUgbG9vcFxuICAgICAgfVxuICAgICAgaWYgKGxhc3RMYXN0SW5kZXggPT09IHN0cmluZy5sZW5ndGgpIHtcbiAgICAgICAgaWYgKGxhc3RMZW5ndGggfHwgIWV4ZWMkMShzZXBhcmF0b3JDb3B5LCAnJykpIHB1c2gob3V0cHV0LCAnJyk7XG4gICAgICB9IGVsc2UgcHVzaChvdXRwdXQsIHN0cmluZ1NsaWNlJDEoc3RyaW5nLCBsYXN0TGFzdEluZGV4KSk7XG4gICAgICByZXR1cm4gb3V0cHV0Lmxlbmd0aCA+IGxpbSA/IGFycmF5U2xpY2Uob3V0cHV0LCAwLCBsaW0pIDogb3V0cHV0O1xuICAgIH07XG4gIC8vIENoYWtyYSwgVjhcbiAgfSBlbHNlIGlmICgnMCcuc3BsaXQodW5kZWZpbmVkLCAwKS5sZW5ndGgpIHtcbiAgICBpbnRlcm5hbFNwbGl0ID0gZnVuY3Rpb24gKHNlcGFyYXRvciwgbGltaXQpIHtcbiAgICAgIHJldHVybiBzZXBhcmF0b3IgPT09IHVuZGVmaW5lZCAmJiBsaW1pdCA9PT0gMCA/IFtdIDogY2FsbCQzKG5hdGl2ZVNwbGl0LCB0aGlzLCBzZXBhcmF0b3IsIGxpbWl0KTtcbiAgICB9O1xuICB9IGVsc2UgaW50ZXJuYWxTcGxpdCA9IG5hdGl2ZVNwbGl0O1xuXG4gIHJldHVybiBbXG4gICAgLy8gYFN0cmluZy5wcm90b3R5cGUuc3BsaXRgIG1ldGhvZFxuICAgIC8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtc3RyaW5nLnByb3RvdHlwZS5zcGxpdFxuICAgIGZ1bmN0aW9uIHNwbGl0KHNlcGFyYXRvciwgbGltaXQpIHtcbiAgICAgIHZhciBPID0gcmVxdWlyZU9iamVjdENvZXJjaWJsZSQzKHRoaXMpO1xuICAgICAgdmFyIHNwbGl0dGVyID0gc2VwYXJhdG9yID09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IGdldE1ldGhvZChzZXBhcmF0b3IsIFNQTElUKTtcbiAgICAgIHJldHVybiBzcGxpdHRlclxuICAgICAgICA/IGNhbGwkMyhzcGxpdHRlciwgc2VwYXJhdG9yLCBPLCBsaW1pdClcbiAgICAgICAgOiBjYWxsJDMoaW50ZXJuYWxTcGxpdCwgdG9TdHJpbmckNChPKSwgc2VwYXJhdG9yLCBsaW1pdCk7XG4gICAgfSxcbiAgICAvLyBgUmVnRXhwLnByb3RvdHlwZVtAQHNwbGl0XWAgbWV0aG9kXG4gICAgLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1yZWdleHAucHJvdG90eXBlLUBAc3BsaXRcbiAgICAvL1xuICAgIC8vIE5PVEU6IFRoaXMgY2Fubm90IGJlIHByb3Blcmx5IHBvbHlmaWxsZWQgaW4gZW5naW5lcyB0aGF0IGRvbid0IHN1cHBvcnRcbiAgICAvLyB0aGUgJ3knIGZsYWcuXG4gICAgZnVuY3Rpb24gKHN0cmluZywgbGltaXQpIHtcbiAgICAgIHZhciByeCA9IGFuT2JqZWN0JDIodGhpcyk7XG4gICAgICB2YXIgUyA9IHRvU3RyaW5nJDQoc3RyaW5nKTtcbiAgICAgIHZhciByZXMgPSBtYXliZUNhbGxOYXRpdmUoaW50ZXJuYWxTcGxpdCwgcngsIFMsIGxpbWl0LCBpbnRlcm5hbFNwbGl0ICE9PSBuYXRpdmVTcGxpdCk7XG5cbiAgICAgIGlmIChyZXMuZG9uZSkgcmV0dXJuIHJlcy52YWx1ZTtcblxuICAgICAgdmFyIEMgPSBzcGVjaWVzQ29uc3RydWN0b3IocngsIFJlZ0V4cCk7XG5cbiAgICAgIHZhciB1bmljb2RlTWF0Y2hpbmcgPSByeC51bmljb2RlO1xuICAgICAgdmFyIGZsYWdzID0gKHJ4Lmlnbm9yZUNhc2UgPyAnaScgOiAnJykgK1xuICAgICAgICAgICAgICAgICAgKHJ4Lm11bHRpbGluZSA/ICdtJyA6ICcnKSArXG4gICAgICAgICAgICAgICAgICAocngudW5pY29kZSA/ICd1JyA6ICcnKSArXG4gICAgICAgICAgICAgICAgICAoVU5TVVBQT1JURURfWSA/ICdnJyA6ICd5Jyk7XG5cbiAgICAgIC8vIF4oPyArIHJ4ICsgKSBpcyBuZWVkZWQsIGluIGNvbWJpbmF0aW9uIHdpdGggc29tZSBTIHNsaWNpbmcsIHRvXG4gICAgICAvLyBzaW11bGF0ZSB0aGUgJ3knIGZsYWcuXG4gICAgICB2YXIgc3BsaXR0ZXIgPSBuZXcgQyhVTlNVUFBPUlRFRF9ZID8gJ14oPzonICsgcnguc291cmNlICsgJyknIDogcngsIGZsYWdzKTtcbiAgICAgIHZhciBsaW0gPSBsaW1pdCA9PT0gdW5kZWZpbmVkID8gTUFYX1VJTlQzMiA6IGxpbWl0ID4+PiAwO1xuICAgICAgaWYgKGxpbSA9PT0gMCkgcmV0dXJuIFtdO1xuICAgICAgaWYgKFMubGVuZ3RoID09PSAwKSByZXR1cm4gY2FsbFJlZ0V4cEV4ZWMoc3BsaXR0ZXIsIFMpID09PSBudWxsID8gW1NdIDogW107XG4gICAgICB2YXIgcCA9IDA7XG4gICAgICB2YXIgcSA9IDA7XG4gICAgICB2YXIgQSA9IFtdO1xuICAgICAgd2hpbGUgKHEgPCBTLmxlbmd0aCkge1xuICAgICAgICBzcGxpdHRlci5sYXN0SW5kZXggPSBVTlNVUFBPUlRFRF9ZID8gMCA6IHE7XG4gICAgICAgIHZhciB6ID0gY2FsbFJlZ0V4cEV4ZWMoc3BsaXR0ZXIsIFVOU1VQUE9SVEVEX1kgPyBzdHJpbmdTbGljZSQxKFMsIHEpIDogUyk7XG4gICAgICAgIHZhciBlO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgeiA9PT0gbnVsbCB8fFxuICAgICAgICAgIChlID0gbWluKHRvTGVuZ3RoJDEoc3BsaXR0ZXIubGFzdEluZGV4ICsgKFVOU1VQUE9SVEVEX1kgPyBxIDogMCkpLCBTLmxlbmd0aCkpID09PSBwXG4gICAgICAgICkge1xuICAgICAgICAgIHEgPSBhZHZhbmNlU3RyaW5nSW5kZXgoUywgcSwgdW5pY29kZU1hdGNoaW5nKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBwdXNoKEEsIHN0cmluZ1NsaWNlJDEoUywgcCwgcSkpO1xuICAgICAgICAgIGlmIChBLmxlbmd0aCA9PT0gbGltKSByZXR1cm4gQTtcbiAgICAgICAgICBmb3IgKHZhciBpID0gMTsgaSA8PSB6Lmxlbmd0aCAtIDE7IGkrKykge1xuICAgICAgICAgICAgcHVzaChBLCB6W2ldKTtcbiAgICAgICAgICAgIGlmIChBLmxlbmd0aCA9PT0gbGltKSByZXR1cm4gQTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcSA9IHAgPSBlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBwdXNoKEEsIHN0cmluZ1NsaWNlJDEoUywgcCkpO1xuICAgICAgcmV0dXJuIEE7XG4gICAgfVxuICBdO1xufSwgIVNQTElUX1dPUktTX1dJVEhfT1ZFUldSSVRURU5fRVhFQywgVU5TVVBQT1JURURfWSk7XG5cbi8vIGEgc3RyaW5nIG9mIGFsbCB2YWxpZCB1bmljb2RlIHdoaXRlc3BhY2VzXG52YXIgd2hpdGVzcGFjZXMkMiA9ICdcXHUwMDA5XFx1MDAwQVxcdTAwMEJcXHUwMDBDXFx1MDAwRFxcdTAwMjBcXHUwMEEwXFx1MTY4MFxcdTIwMDBcXHUyMDAxXFx1MjAwMicgK1xuICAnXFx1MjAwM1xcdTIwMDRcXHUyMDA1XFx1MjAwNlxcdTIwMDdcXHUyMDA4XFx1MjAwOVxcdTIwMEFcXHUyMDJGXFx1MjA1RlxcdTMwMDBcXHUyMDI4XFx1MjAyOVxcdUZFRkYnO1xuXG52YXIgdW5jdXJyeVRoaXMkNCA9IGZ1bmN0aW9uVW5jdXJyeVRoaXM7XG52YXIgcmVxdWlyZU9iamVjdENvZXJjaWJsZSQyID0gcmVxdWlyZU9iamVjdENvZXJjaWJsZSQ3O1xudmFyIHRvU3RyaW5nJDMgPSB0b1N0cmluZyQ3O1xudmFyIHdoaXRlc3BhY2VzJDEgPSB3aGl0ZXNwYWNlcyQyO1xuXG52YXIgcmVwbGFjZSA9IHVuY3VycnlUaGlzJDQoJycucmVwbGFjZSk7XG52YXIgd2hpdGVzcGFjZSA9ICdbJyArIHdoaXRlc3BhY2VzJDEgKyAnXSc7XG52YXIgbHRyaW0gPSBSZWdFeHAoJ14nICsgd2hpdGVzcGFjZSArIHdoaXRlc3BhY2UgKyAnKicpO1xudmFyIHJ0cmltID0gUmVnRXhwKHdoaXRlc3BhY2UgKyB3aGl0ZXNwYWNlICsgJyokJyk7XG5cbi8vIGBTdHJpbmcucHJvdG90eXBlLnsgdHJpbSwgdHJpbVN0YXJ0LCB0cmltRW5kLCB0cmltTGVmdCwgdHJpbVJpZ2h0IH1gIG1ldGhvZHMgaW1wbGVtZW50YXRpb25cbnZhciBjcmVhdGVNZXRob2QkMSA9IGZ1bmN0aW9uIChUWVBFKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoJHRoaXMpIHtcbiAgICB2YXIgc3RyaW5nID0gdG9TdHJpbmckMyhyZXF1aXJlT2JqZWN0Q29lcmNpYmxlJDIoJHRoaXMpKTtcbiAgICBpZiAoVFlQRSAmIDEpIHN0cmluZyA9IHJlcGxhY2Uoc3RyaW5nLCBsdHJpbSwgJycpO1xuICAgIGlmIChUWVBFICYgMikgc3RyaW5nID0gcmVwbGFjZShzdHJpbmcsIHJ0cmltLCAnJyk7XG4gICAgcmV0dXJuIHN0cmluZztcbiAgfTtcbn07XG5cbnZhciBzdHJpbmdUcmltID0ge1xuICAvLyBgU3RyaW5nLnByb3RvdHlwZS57IHRyaW1MZWZ0LCB0cmltU3RhcnQgfWAgbWV0aG9kc1xuICAvLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLXN0cmluZy5wcm90b3R5cGUudHJpbXN0YXJ0XG4gIHN0YXJ0OiBjcmVhdGVNZXRob2QkMSgxKSxcbiAgLy8gYFN0cmluZy5wcm90b3R5cGUueyB0cmltUmlnaHQsIHRyaW1FbmQgfWAgbWV0aG9kc1xuICAvLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLXN0cmluZy5wcm90b3R5cGUudHJpbWVuZFxuICBlbmQ6IGNyZWF0ZU1ldGhvZCQxKDIpLFxuICAvLyBgU3RyaW5nLnByb3RvdHlwZS50cmltYCBtZXRob2RcbiAgLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1zdHJpbmcucHJvdG90eXBlLnRyaW1cbiAgdHJpbTogY3JlYXRlTWV0aG9kJDEoMylcbn07XG5cbnZhciBnbG9iYWwkMiA9IGdsb2JhbCRmO1xudmFyIGZhaWxzJDQgPSBmYWlscyRqO1xudmFyIHVuY3VycnlUaGlzJDMgPSBmdW5jdGlvblVuY3VycnlUaGlzO1xudmFyIHRvU3RyaW5nJDIgPSB0b1N0cmluZyQ3O1xudmFyIHRyaW0gPSBzdHJpbmdUcmltLnRyaW07XG52YXIgd2hpdGVzcGFjZXMgPSB3aGl0ZXNwYWNlcyQyO1xuXG52YXIgJHBhcnNlSW50JDEgPSBnbG9iYWwkMi5wYXJzZUludDtcbnZhciBTeW1ib2wkMSA9IGdsb2JhbCQyLlN5bWJvbDtcbnZhciBJVEVSQVRPUiQzID0gU3ltYm9sJDEgJiYgU3ltYm9sJDEuaXRlcmF0b3I7XG52YXIgaGV4ID0gL15bKy1dPzB4L2k7XG52YXIgZXhlYyA9IHVuY3VycnlUaGlzJDMoaGV4LmV4ZWMpO1xudmFyIEZPUkNFRCA9ICRwYXJzZUludCQxKHdoaXRlc3BhY2VzICsgJzA4JykgIT09IDggfHwgJHBhcnNlSW50JDEod2hpdGVzcGFjZXMgKyAnMHgxNicpICE9PSAyMlxuICAvLyBNUyBFZGdlIDE4LSBicm9rZW4gd2l0aCBib3hlZCBzeW1ib2xzXG4gIHx8IChJVEVSQVRPUiQzICYmICFmYWlscyQ0KGZ1bmN0aW9uICgpIHsgJHBhcnNlSW50JDEoT2JqZWN0KElURVJBVE9SJDMpKTsgfSkpO1xuXG4vLyBgcGFyc2VJbnRgIG1ldGhvZFxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1wYXJzZWludC1zdHJpbmctcmFkaXhcbnZhciBudW1iZXJQYXJzZUludCA9IEZPUkNFRCA/IGZ1bmN0aW9uIHBhcnNlSW50KHN0cmluZywgcmFkaXgpIHtcbiAgdmFyIFMgPSB0cmltKHRvU3RyaW5nJDIoc3RyaW5nKSk7XG4gIHJldHVybiAkcGFyc2VJbnQkMShTLCAocmFkaXggPj4+IDApIHx8IChleGVjKGhleCwgUykgPyAxNiA6IDEwKSk7XG59IDogJHBhcnNlSW50JDE7XG5cbnZhciAkJDMgPSBfZXhwb3J0O1xudmFyICRwYXJzZUludCA9IG51bWJlclBhcnNlSW50O1xuXG4vLyBgcGFyc2VJbnRgIG1ldGhvZFxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1wYXJzZWludC1zdHJpbmctcmFkaXhcbiQkMyh7IGdsb2JhbDogdHJ1ZSwgZm9yY2VkOiBwYXJzZUludCAhPSAkcGFyc2VJbnQgfSwge1xuICBwYXJzZUludDogJHBhcnNlSW50XG59KTtcblxudmFyIGNhbGwkMiA9IGZ1bmN0aW9uQ2FsbDtcbnZhciBoYXNPd24kMiA9IGhhc093blByb3BlcnR5XzE7XG52YXIgaXNQcm90b3R5cGVPZiA9IG9iamVjdElzUHJvdG90eXBlT2Y7XG52YXIgcmVnRXhwRmxhZ3MgPSByZWdleHBGbGFncyQxO1xuXG52YXIgUmVnRXhwUHJvdG90eXBlJDEgPSBSZWdFeHAucHJvdG90eXBlO1xuXG52YXIgcmVnZXhwR2V0RmxhZ3MgPSBmdW5jdGlvbiAoUikge1xuICB2YXIgZmxhZ3MgPSBSLmZsYWdzO1xuICByZXR1cm4gZmxhZ3MgPT09IHVuZGVmaW5lZCAmJiAhKCdmbGFncycgaW4gUmVnRXhwUHJvdG90eXBlJDEpICYmICFoYXNPd24kMihSLCAnZmxhZ3MnKSAmJiBpc1Byb3RvdHlwZU9mKFJlZ0V4cFByb3RvdHlwZSQxLCBSKVxuICAgID8gY2FsbCQyKHJlZ0V4cEZsYWdzLCBSKSA6IGZsYWdzO1xufTtcblxudmFyIFBST1BFUl9GVU5DVElPTl9OQU1FJDEgPSBmdW5jdGlvbk5hbWUuUFJPUEVSO1xudmFyIGRlZmluZUJ1aWx0SW4kMiA9IGRlZmluZUJ1aWx0SW4kNTtcbnZhciBhbk9iamVjdCQxID0gYW5PYmplY3QkYTtcbnZhciAkdG9TdHJpbmcgPSB0b1N0cmluZyQ3O1xudmFyIGZhaWxzJDMgPSBmYWlscyRqO1xudmFyIGdldFJlZ0V4cEZsYWdzID0gcmVnZXhwR2V0RmxhZ3M7XG5cbnZhciBUT19TVFJJTkcgPSAndG9TdHJpbmcnO1xudmFyIFJlZ0V4cFByb3RvdHlwZSA9IFJlZ0V4cC5wcm90b3R5cGU7XG52YXIgbiRUb1N0cmluZyA9IFJlZ0V4cFByb3RvdHlwZVtUT19TVFJJTkddO1xuXG52YXIgTk9UX0dFTkVSSUMgPSBmYWlscyQzKGZ1bmN0aW9uICgpIHsgcmV0dXJuIG4kVG9TdHJpbmcuY2FsbCh7IHNvdXJjZTogJ2EnLCBmbGFnczogJ2InIH0pICE9ICcvYS9iJzsgfSk7XG4vLyBGRjQ0LSBSZWdFeHAjdG9TdHJpbmcgaGFzIGEgd3JvbmcgbmFtZVxudmFyIElOQ09SUkVDVF9OQU1FID0gUFJPUEVSX0ZVTkNUSU9OX05BTUUkMSAmJiBuJFRvU3RyaW5nLm5hbWUgIT0gVE9fU1RSSU5HO1xuXG4vLyBgUmVnRXhwLnByb3RvdHlwZS50b1N0cmluZ2AgbWV0aG9kXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLXJlZ2V4cC5wcm90b3R5cGUudG9zdHJpbmdcbmlmIChOT1RfR0VORVJJQyB8fCBJTkNPUlJFQ1RfTkFNRSkge1xuICBkZWZpbmVCdWlsdEluJDIoUmVnRXhwLnByb3RvdHlwZSwgVE9fU1RSSU5HLCBmdW5jdGlvbiB0b1N0cmluZygpIHtcbiAgICB2YXIgUiA9IGFuT2JqZWN0JDEodGhpcyk7XG4gICAgdmFyIHBhdHRlcm4gPSAkdG9TdHJpbmcoUi5zb3VyY2UpO1xuICAgIHZhciBmbGFncyA9ICR0b1N0cmluZyhnZXRSZWdFeHBGbGFncyhSKSk7XG4gICAgcmV0dXJuICcvJyArIHBhdHRlcm4gKyAnLycgKyBmbGFncztcbiAgfSwgeyB1bnNhZmU6IHRydWUgfSk7XG59XG5cbmNvbnN0IEZFQVRVUkVfUk9XX0lOREVYID0gMDtcbmNvbnN0IEZFQVRVUkVfQ09MX0lOREVYID0gMTtcbmNvbnN0IEZFQVRVUkVfQ0VMTFNfU1RBUlRfSU5ERVggPSAyO1xuY29uc3QgQ0VMTF9OVU1fSU5ERVggPSAwO1xuY29uc3QgQ0VMTF9TVEFSVF9JTkRFWCA9IDE7XG5jb25zdCBDRUxMX0VORF9JTkRFWCA9IDI7XG5jb25zdCBDRUxMX1ZBTFVFU19TVEFSVF9JTkRFWCA9IDM7IC8vIFZhbHVlcyBmcm9tIHRoZSA0d2luZ3MgQVBJIGluIGludEFycmF5IGZvcm0gY2FuJ3QgYmUgZmxvYXRzLCBzbyB0aGV5IGFyZSBtdWx0aXBsaWVkIGJ5IGEgZmFjdG9yLCBoZXJlIHdlIGdldCBiYWNrIHRvIHRoZSBvcmlnaW5hbCB2YWx1ZVxuXG5jb25zdCBWQUxVRV9NVUxUSVBMSUVSID0gMTAwO1xuXG5jb25zdCBnZXRDZWxsVmFsdWVzID0gcmF3VmFsdWVzID0+IHtcbiAgLy8gUmF3IHZhbHVlcyBjb21lIGFzIGEgc2luZ2xlIHN0cmluZyAoTVZUIGxpbWl0YXRpb24pLCB0dXJuIGludG8gYW4gYXJyYXkgb2YgaW50cyBmaXJzdFxuICBjb25zdCB2YWx1ZXMgPSBBcnJheS5pc0FycmF5KHJhd1ZhbHVlcykgPyByYXdWYWx1ZXMgOiByYXdWYWx1ZXMuc2xpY2UoMSwgLTEpLnNwbGl0KCcsJykubWFwKHYgPT4gcGFyc2VJbnQodikpOyAvLyBGaXJzdCB0d28gdmFsdWVzIGZvciBhIGNlbGwgYXJlIHRoZSBvdmVyYWxsIHN0YXJ0IGFuZCBlbmQgdGltZSBvZmZzZXRzIGZvciBhbGwgdGhlIGNlbGwgdmFsdWVzIChpbiBkYXlzL2hvdXJzLzEwZGF5cyBmcm9tIHN0YXJ0IG9mIHRpbWUpXG5cbiAgY29uc3QgbWluQ2VsbE9mZnNldCA9IHZhbHVlc1tDRUxMX1NUQVJUX0lOREVYXTtcbiAgY29uc3QgbWF4Q2VsbE9mZnNldCA9IHZhbHVlc1tDRUxMX0VORF9JTkRFWF07XG4gIHJldHVybiB7XG4gICAgdmFsdWVzLFxuICAgIG1pbkNlbGxPZmZzZXQsXG4gICAgbWF4Q2VsbE9mZnNldFxuICB9O1xufTtcbmNvbnN0IGdldFJlYWxWYWx1ZSA9IChyYXdWYWx1ZSwge1xuICBtdWx0aXBsaWVyOiBfbXVsdGlwbGllciA9IFZBTFVFX01VTFRJUExJRVIsXG4gIG9mZnNldDogX29mZnNldCA9IDBcbn0gPSB7fSkgPT4ge1xuICByZXR1cm4gcmF3VmFsdWUgLyBfbXVsdGlwbGllciAtIF9vZmZzZXQ7XG59O1xuY29uc3QgZ2V0UmVhbFZhbHVlcyA9IChyYXdWYWx1ZXMsIG9wdGlvbnMgPSB7fSkgPT4ge1xuICAvLyBSYXcgNHcgQVBJIHZhbHVlcyBjb21lIHdpdGhvdXQgZGVjaW1hbHMsIG11bHRpcGxpZWQgYnkgMTAwXG4gIGNvbnN0IHJlYWxWYWx1ZXMgPSByYXdWYWx1ZXMubWFwKHN1YmxheWVyVmFsdWUgPT4gZ2V0UmVhbFZhbHVlKHN1YmxheWVyVmFsdWUsIG9wdGlvbnMpKTtcbiAgcmV0dXJuIHJlYWxWYWx1ZXM7XG59O1xuY29uc3QgZ2V0Q2VsbEFycmF5SW5kZXggPSAobWluQ2VsbE9mZnNldCwgbnVtU3VibGF5ZXJzLCBvZmZzZXQpID0+IHtcbiAgcmV0dXJuIENFTExfVkFMVUVTX1NUQVJUX0lOREVYICsgKG9mZnNldCAtIG1pbkNlbGxPZmZzZXQpICogbnVtU3VibGF5ZXJzO1xufTtcblxuY29uc3QgZ2V0TGFzdERpZ2l0ID0gbnVtID0+IHBhcnNlSW50KG51bS50b1N0cmluZygpLnNsaWNlKC0xKSk7IC8vIEluIG9yZGVyIGZvciBzZXRGZWF0dXJlU3RhdGUgdG8gd29yayBjb3JyZWN0bHksIGdlbmVyYXRlIHVuaXF1ZSBJRHMgYWNyb3NzIHZpZXdwb3J0LXZpc2libGUgdGlsZXM6XG4vLyBjb25jYXRlbmF0ZSBsYXN0IHgveiBkaWdpdHMgYW5kIGNlbGwgaW5jcmVtZW50IGluZGV4IChnb2FsIGlzIHRvIGdldCBudW1iZXJzIGFzIHNtYWxsIGFzIHBvc3NpYmxlKVxuXG5cbmNvbnN0IGdlbmVyYXRlVW5pcXVlSWQgPSAoeCwgeSwgY2VsbElkKSA9PiBwYXJzZUludChbZ2V0TGFzdERpZ2l0KHgpICsgMSwgZ2V0TGFzdERpZ2l0KHkpICsgMSwgY2VsbElkXS5qb2luKCcnKSk7XG5cbnZhciBHZW9tVHlwZTtcblxuKGZ1bmN0aW9uIChHZW9tVHlwZSkge1xuICBHZW9tVHlwZVtcInBvaW50XCJdID0gXCJwb2ludFwiO1xuICBHZW9tVHlwZVtcInJlY3RhbmdsZVwiXSA9IFwicmVjdGFuZ2xlXCI7XG59KShHZW9tVHlwZSB8fCAoR2VvbVR5cGUgPSB7fSkpO1xuXG52YXIgU3VibGF5ZXJDb21iaW5hdGlvbk1vZGU7XG5cbihmdW5jdGlvbiAoU3VibGF5ZXJDb21iaW5hdGlvbk1vZGUpIHtcbiAgU3VibGF5ZXJDb21iaW5hdGlvbk1vZGVbXCJOb25lXCJdID0gXCJub25lXCI7IC8vIEFkZCBhbGwgc3VibGF5ZXIgcmF3IHZhbHVlc1xuXG4gIFN1YmxheWVyQ29tYmluYXRpb25Nb2RlW1wiQWRkXCJdID0gXCJhZGRcIjsgLy8gUmV0dXJucyBhIGJ1Y2tldCBpbmRleCBkZXBlbmRpbmcgb24gc3VibGF5ZXIgd2l0aCBoaWdoZXN0IHZhbHVlICsgcG9zaXRpb24gb24gc3VibGF5ZXIgY29sb3IgcmFtcFxuXG4gIFN1YmxheWVyQ29tYmluYXRpb25Nb2RlW1wiTWF4XCJdID0gXCJtYXhcIjsgLy8gUmV0dXJucyBhIGJ1Y2tldCBpbmRleCBkZXBlbmRpbmcgb24gZGVsdGEgdmFsdWUgYmV0d2VlbiB0d28gc3VibGF5ZXJzXG5cbiAgU3VibGF5ZXJDb21iaW5hdGlvbk1vZGVbXCJUaW1lQ29tcGFyZVwiXSA9IFwidGltZWNvbXBhcmVcIjsgLy8gUmV0dXJucyBhIGJ1Y2tldCBpbmRleCBkZXBlbmRpbmcgb24gYSAyRCBjb2xvciByYW1wXG5cbiAgU3VibGF5ZXJDb21iaW5hdGlvbk1vZGVbXCJCaXZhcmlhdGVcIl0gPSBcImJpdmFyaWF0ZVwiOyAvLyBSZXR1cm5zIHJhdyB2YWx1ZXMgdGhhdCBjYW4gYmUgZGVjb2RlZCB3aXRoIEpTT04ucGFyc2UgKG51bWJlciBvciBhcnJheSBvZiBudW1iZXJzKS4gVXNlZCBmb3IgaW50ZXJhY3Rpb24gbGF5ZXJcblxuICBTdWJsYXllckNvbWJpbmF0aW9uTW9kZVtcIkxpdGVyYWxcIl0gPSBcImxpdGVyYWxcIjsgLy8gUmV0dXJucyByYXcgdmFsdWVzIGFzIGEgc3RyaW5nIGluIHRoZSBmb3JtYXQgQUFBQUJCQkJDQ0NDICh3aGVyZSBBLCBCLCBDLCAzIHN1YmxheWVycyksIGFuZCB3aGVyZSBCQkJCIGlzXG4gIC8vIHN1YmxheWVyIDAgKyBzdWJsYXllciAxIGFuZCBDQ0NDIGlzIHN1YmxheWVyIDAgKyBzdWJsYXllciAxICsgc3VibGF5ZXIgMi4gVXNlZCBmb3IgZXh0cnVkZWQgbGF5ZXIuXG5cbiAgU3VibGF5ZXJDb21iaW5hdGlvbk1vZGVbXCJDdW11bGF0aXZlXCJdID0gXCJjdW11bGF0aXZlXCI7XG59KShTdWJsYXllckNvbWJpbmF0aW9uTW9kZSB8fCAoU3VibGF5ZXJDb21iaW5hdGlvbk1vZGUgPSB7fSkpO1xuXG52YXIgQWdncmVnYXRpb25PcGVyYXRpb247XG5cbihmdW5jdGlvbiAoQWdncmVnYXRpb25PcGVyYXRpb24pIHtcbiAgQWdncmVnYXRpb25PcGVyYXRpb25bXCJTdW1cIl0gPSBcInN1bVwiO1xuICBBZ2dyZWdhdGlvbk9wZXJhdGlvbltcIkF2Z1wiXSA9IFwiYXZnXCI7XG59KShBZ2dyZWdhdGlvbk9wZXJhdGlvbiB8fCAoQWdncmVnYXRpb25PcGVyYXRpb24gPSB7fSkpO1xuXG52YXIgd2VsbEtub3duU3ltYm9sJDQgPSB3ZWxsS25vd25TeW1ib2wkYjtcbnZhciBjcmVhdGUkMSA9IG9iamVjdENyZWF0ZTtcbnZhciBkZWZpbmVQcm9wZXJ0eSQzID0gb2JqZWN0RGVmaW5lUHJvcGVydHkuZjtcblxudmFyIFVOU0NPUEFCTEVTID0gd2VsbEtub3duU3ltYm9sJDQoJ3Vuc2NvcGFibGVzJyk7XG52YXIgQXJyYXlQcm90b3R5cGUgPSBBcnJheS5wcm90b3R5cGU7XG5cbi8vIEFycmF5LnByb3RvdHlwZVtAQHVuc2NvcGFibGVzXVxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1hcnJheS5wcm90b3R5cGUtQEB1bnNjb3BhYmxlc1xuaWYgKEFycmF5UHJvdG90eXBlW1VOU0NPUEFCTEVTXSA9PSB1bmRlZmluZWQpIHtcbiAgZGVmaW5lUHJvcGVydHkkMyhBcnJheVByb3RvdHlwZSwgVU5TQ09QQUJMRVMsIHtcbiAgICBjb25maWd1cmFibGU6IHRydWUsXG4gICAgdmFsdWU6IGNyZWF0ZSQxKG51bGwpXG4gIH0pO1xufVxuXG4vLyBhZGQgYSBrZXkgdG8gQXJyYXkucHJvdG90eXBlW0BAdW5zY29wYWJsZXNdXG52YXIgYWRkVG9VbnNjb3BhYmxlcyQxID0gZnVuY3Rpb24gKGtleSkge1xuICBBcnJheVByb3RvdHlwZVtVTlNDT1BBQkxFU11ba2V5XSA9IHRydWU7XG59O1xuXG52YXIgaXRlcmF0b3JzID0ge307XG5cbnZhciBmYWlscyQyID0gZmFpbHMkajtcblxudmFyIGNvcnJlY3RQcm90b3R5cGVHZXR0ZXIgPSAhZmFpbHMkMihmdW5jdGlvbiAoKSB7XG4gIGZ1bmN0aW9uIEYoKSB7IC8qIGVtcHR5ICovIH1cbiAgRi5wcm90b3R5cGUuY29uc3RydWN0b3IgPSBudWxsO1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZXMteC9uby1vYmplY3QtZ2V0cHJvdG90eXBlb2YgLS0gcmVxdWlyZWQgZm9yIHRlc3RpbmdcbiAgcmV0dXJuIE9iamVjdC5nZXRQcm90b3R5cGVPZihuZXcgRigpKSAhPT0gRi5wcm90b3R5cGU7XG59KTtcblxudmFyIGhhc093biQxID0gaGFzT3duUHJvcGVydHlfMTtcbnZhciBpc0NhbGxhYmxlJDMgPSBpc0NhbGxhYmxlJGg7XG52YXIgdG9PYmplY3QkMSA9IHRvT2JqZWN0JDM7XG52YXIgc2hhcmVkS2V5ID0gc2hhcmVkS2V5JDM7XG52YXIgQ09SUkVDVF9QUk9UT1RZUEVfR0VUVEVSID0gY29ycmVjdFByb3RvdHlwZUdldHRlcjtcblxudmFyIElFX1BST1RPID0gc2hhcmVkS2V5KCdJRV9QUk9UTycpO1xudmFyICRPYmplY3QgPSBPYmplY3Q7XG52YXIgT2JqZWN0UHJvdG90eXBlID0gJE9iamVjdC5wcm90b3R5cGU7XG5cbi8vIGBPYmplY3QuZ2V0UHJvdG90eXBlT2ZgIG1ldGhvZFxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1vYmplY3QuZ2V0cHJvdG90eXBlb2Zcbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBlcy14L25vLW9iamVjdC1nZXRwcm90b3R5cGVvZiAtLSBzYWZlXG52YXIgb2JqZWN0R2V0UHJvdG90eXBlT2YgPSBDT1JSRUNUX1BST1RPVFlQRV9HRVRURVIgPyAkT2JqZWN0LmdldFByb3RvdHlwZU9mIDogZnVuY3Rpb24gKE8pIHtcbiAgdmFyIG9iamVjdCA9IHRvT2JqZWN0JDEoTyk7XG4gIGlmIChoYXNPd24kMShvYmplY3QsIElFX1BST1RPKSkgcmV0dXJuIG9iamVjdFtJRV9QUk9UT107XG4gIHZhciBjb25zdHJ1Y3RvciA9IG9iamVjdC5jb25zdHJ1Y3RvcjtcbiAgaWYgKGlzQ2FsbGFibGUkMyhjb25zdHJ1Y3RvcikgJiYgb2JqZWN0IGluc3RhbmNlb2YgY29uc3RydWN0b3IpIHtcbiAgICByZXR1cm4gY29uc3RydWN0b3IucHJvdG90eXBlO1xuICB9IHJldHVybiBvYmplY3QgaW5zdGFuY2VvZiAkT2JqZWN0ID8gT2JqZWN0UHJvdG90eXBlIDogbnVsbDtcbn07XG5cbnZhciBmYWlscyQxID0gZmFpbHMkajtcbnZhciBpc0NhbGxhYmxlJDIgPSBpc0NhbGxhYmxlJGg7XG52YXIgZ2V0UHJvdG90eXBlT2YkMSA9IG9iamVjdEdldFByb3RvdHlwZU9mO1xudmFyIGRlZmluZUJ1aWx0SW4kMSA9IGRlZmluZUJ1aWx0SW4kNTtcbnZhciB3ZWxsS25vd25TeW1ib2wkMyA9IHdlbGxLbm93blN5bWJvbCRiO1xuXG52YXIgSVRFUkFUT1IkMiA9IHdlbGxLbm93blN5bWJvbCQzKCdpdGVyYXRvcicpO1xudmFyIEJVR0dZX1NBRkFSSV9JVEVSQVRPUlMkMSA9IGZhbHNlO1xuXG4vLyBgJUl0ZXJhdG9yUHJvdG90eXBlJWAgb2JqZWN0XG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLSVpdGVyYXRvcnByb3RvdHlwZSUtb2JqZWN0XG52YXIgSXRlcmF0b3JQcm90b3R5cGUkMiwgUHJvdG90eXBlT2ZBcnJheUl0ZXJhdG9yUHJvdG90eXBlLCBhcnJheUl0ZXJhdG9yO1xuXG4vKiBlc2xpbnQtZGlzYWJsZSBlcy14L25vLWFycmF5LXByb3RvdHlwZS1rZXlzIC0tIHNhZmUgKi9cbmlmIChbXS5rZXlzKSB7XG4gIGFycmF5SXRlcmF0b3IgPSBbXS5rZXlzKCk7XG4gIC8vIFNhZmFyaSA4IGhhcyBidWdneSBpdGVyYXRvcnMgdy9vIGBuZXh0YFxuICBpZiAoISgnbmV4dCcgaW4gYXJyYXlJdGVyYXRvcikpIEJVR0dZX1NBRkFSSV9JVEVSQVRPUlMkMSA9IHRydWU7XG4gIGVsc2Uge1xuICAgIFByb3RvdHlwZU9mQXJyYXlJdGVyYXRvclByb3RvdHlwZSA9IGdldFByb3RvdHlwZU9mJDEoZ2V0UHJvdG90eXBlT2YkMShhcnJheUl0ZXJhdG9yKSk7XG4gICAgaWYgKFByb3RvdHlwZU9mQXJyYXlJdGVyYXRvclByb3RvdHlwZSAhPT0gT2JqZWN0LnByb3RvdHlwZSkgSXRlcmF0b3JQcm90b3R5cGUkMiA9IFByb3RvdHlwZU9mQXJyYXlJdGVyYXRvclByb3RvdHlwZTtcbiAgfVxufVxuXG52YXIgTkVXX0lURVJBVE9SX1BST1RPVFlQRSA9IEl0ZXJhdG9yUHJvdG90eXBlJDIgPT0gdW5kZWZpbmVkIHx8IGZhaWxzJDEoZnVuY3Rpb24gKCkge1xuICB2YXIgdGVzdCA9IHt9O1xuICAvLyBGRjQ0LSBsZWdhY3kgaXRlcmF0b3JzIGNhc2VcbiAgcmV0dXJuIEl0ZXJhdG9yUHJvdG90eXBlJDJbSVRFUkFUT1IkMl0uY2FsbCh0ZXN0KSAhPT0gdGVzdDtcbn0pO1xuXG5pZiAoTkVXX0lURVJBVE9SX1BST1RPVFlQRSkgSXRlcmF0b3JQcm90b3R5cGUkMiA9IHt9O1xuXG4vLyBgJUl0ZXJhdG9yUHJvdG90eXBlJVtAQGl0ZXJhdG9yXSgpYCBtZXRob2Rcbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtJWl0ZXJhdG9ycHJvdG90eXBlJS1AQGl0ZXJhdG9yXG5pZiAoIWlzQ2FsbGFibGUkMihJdGVyYXRvclByb3RvdHlwZSQyW0lURVJBVE9SJDJdKSkge1xuICBkZWZpbmVCdWlsdEluJDEoSXRlcmF0b3JQcm90b3R5cGUkMiwgSVRFUkFUT1IkMiwgZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzO1xuICB9KTtcbn1cblxudmFyIGl0ZXJhdG9yc0NvcmUgPSB7XG4gIEl0ZXJhdG9yUHJvdG90eXBlOiBJdGVyYXRvclByb3RvdHlwZSQyLFxuICBCVUdHWV9TQUZBUklfSVRFUkFUT1JTOiBCVUdHWV9TQUZBUklfSVRFUkFUT1JTJDFcbn07XG5cbnZhciBkZWZpbmVQcm9wZXJ0eSQyID0gb2JqZWN0RGVmaW5lUHJvcGVydHkuZjtcbnZhciBoYXNPd24gPSBoYXNPd25Qcm9wZXJ0eV8xO1xudmFyIHdlbGxLbm93blN5bWJvbCQyID0gd2VsbEtub3duU3ltYm9sJGI7XG5cbnZhciBUT19TVFJJTkdfVEFHJDEgPSB3ZWxsS25vd25TeW1ib2wkMigndG9TdHJpbmdUYWcnKTtcblxudmFyIHNldFRvU3RyaW5nVGFnJDIgPSBmdW5jdGlvbiAodGFyZ2V0LCBUQUcsIFNUQVRJQykge1xuICBpZiAodGFyZ2V0ICYmICFTVEFUSUMpIHRhcmdldCA9IHRhcmdldC5wcm90b3R5cGU7XG4gIGlmICh0YXJnZXQgJiYgIWhhc093bih0YXJnZXQsIFRPX1NUUklOR19UQUckMSkpIHtcbiAgICBkZWZpbmVQcm9wZXJ0eSQyKHRhcmdldCwgVE9fU1RSSU5HX1RBRyQxLCB7IGNvbmZpZ3VyYWJsZTogdHJ1ZSwgdmFsdWU6IFRBRyB9KTtcbiAgfVxufTtcblxudmFyIEl0ZXJhdG9yUHJvdG90eXBlJDEgPSBpdGVyYXRvcnNDb3JlLkl0ZXJhdG9yUHJvdG90eXBlO1xudmFyIGNyZWF0ZSA9IG9iamVjdENyZWF0ZTtcbnZhciBjcmVhdGVQcm9wZXJ0eURlc2NyaXB0b3IgPSBjcmVhdGVQcm9wZXJ0eURlc2NyaXB0b3IkNDtcbnZhciBzZXRUb1N0cmluZ1RhZyQxID0gc2V0VG9TdHJpbmdUYWckMjtcbnZhciBJdGVyYXRvcnMkMiA9IGl0ZXJhdG9ycztcblxudmFyIHJldHVyblRoaXMkMSA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuIHRoaXM7IH07XG5cbnZhciBjcmVhdGVJdGVyYXRvckNvbnN0cnVjdG9yJDEgPSBmdW5jdGlvbiAoSXRlcmF0b3JDb25zdHJ1Y3RvciwgTkFNRSwgbmV4dCwgRU5VTUVSQUJMRV9ORVhUKSB7XG4gIHZhciBUT19TVFJJTkdfVEFHID0gTkFNRSArICcgSXRlcmF0b3InO1xuICBJdGVyYXRvckNvbnN0cnVjdG9yLnByb3RvdHlwZSA9IGNyZWF0ZShJdGVyYXRvclByb3RvdHlwZSQxLCB7IG5leHQ6IGNyZWF0ZVByb3BlcnR5RGVzY3JpcHRvcigrIUVOVU1FUkFCTEVfTkVYVCwgbmV4dCkgfSk7XG4gIHNldFRvU3RyaW5nVGFnJDEoSXRlcmF0b3JDb25zdHJ1Y3RvciwgVE9fU1RSSU5HX1RBRywgZmFsc2UpO1xuICBJdGVyYXRvcnMkMltUT19TVFJJTkdfVEFHXSA9IHJldHVyblRoaXMkMTtcbiAgcmV0dXJuIEl0ZXJhdG9yQ29uc3RydWN0b3I7XG59O1xuXG52YXIgaXNDYWxsYWJsZSQxID0gaXNDYWxsYWJsZSRoO1xuXG52YXIgJFN0cmluZyA9IFN0cmluZztcbnZhciAkVHlwZUVycm9yID0gVHlwZUVycm9yO1xuXG52YXIgYVBvc3NpYmxlUHJvdG90eXBlJDEgPSBmdW5jdGlvbiAoYXJndW1lbnQpIHtcbiAgaWYgKHR5cGVvZiBhcmd1bWVudCA9PSAnb2JqZWN0JyB8fCBpc0NhbGxhYmxlJDEoYXJndW1lbnQpKSByZXR1cm4gYXJndW1lbnQ7XG4gIHRocm93ICRUeXBlRXJyb3IoXCJDYW4ndCBzZXQgXCIgKyAkU3RyaW5nKGFyZ3VtZW50KSArICcgYXMgYSBwcm90b3R5cGUnKTtcbn07XG5cbi8qIGVzbGludC1kaXNhYmxlIG5vLXByb3RvIC0tIHNhZmUgKi9cblxudmFyIHVuY3VycnlUaGlzJDIgPSBmdW5jdGlvblVuY3VycnlUaGlzO1xudmFyIGFuT2JqZWN0ID0gYW5PYmplY3QkYTtcbnZhciBhUG9zc2libGVQcm90b3R5cGUgPSBhUG9zc2libGVQcm90b3R5cGUkMTtcblxuLy8gYE9iamVjdC5zZXRQcm90b3R5cGVPZmAgbWV0aG9kXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLW9iamVjdC5zZXRwcm90b3R5cGVvZlxuLy8gV29ya3Mgd2l0aCBfX3Byb3RvX18gb25seS4gT2xkIHY4IGNhbid0IHdvcmsgd2l0aCBudWxsIHByb3RvIG9iamVjdHMuXG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZXMteC9uby1vYmplY3Qtc2V0cHJvdG90eXBlb2YgLS0gc2FmZVxudmFyIG9iamVjdFNldFByb3RvdHlwZU9mID0gT2JqZWN0LnNldFByb3RvdHlwZU9mIHx8ICgnX19wcm90b19fJyBpbiB7fSA/IGZ1bmN0aW9uICgpIHtcbiAgdmFyIENPUlJFQ1RfU0VUVEVSID0gZmFsc2U7XG4gIHZhciB0ZXN0ID0ge307XG4gIHZhciBzZXR0ZXI7XG4gIHRyeSB7XG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tb2JqZWN0LWdldG93bnByb3BlcnR5ZGVzY3JpcHRvciAtLSBzYWZlXG4gICAgc2V0dGVyID0gdW5jdXJyeVRoaXMkMihPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKE9iamVjdC5wcm90b3R5cGUsICdfX3Byb3RvX18nKS5zZXQpO1xuICAgIHNldHRlcih0ZXN0LCBbXSk7XG4gICAgQ09SUkVDVF9TRVRURVIgPSB0ZXN0IGluc3RhbmNlb2YgQXJyYXk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7IC8qIGVtcHR5ICovIH1cbiAgcmV0dXJuIGZ1bmN0aW9uIHNldFByb3RvdHlwZU9mKE8sIHByb3RvKSB7XG4gICAgYW5PYmplY3QoTyk7XG4gICAgYVBvc3NpYmxlUHJvdG90eXBlKHByb3RvKTtcbiAgICBpZiAoQ09SUkVDVF9TRVRURVIpIHNldHRlcihPLCBwcm90byk7XG4gICAgZWxzZSBPLl9fcHJvdG9fXyA9IHByb3RvO1xuICAgIHJldHVybiBPO1xuICB9O1xufSgpIDogdW5kZWZpbmVkKTtcblxudmFyICQkMiA9IF9leHBvcnQ7XG52YXIgY2FsbCQxID0gZnVuY3Rpb25DYWxsO1xudmFyIEZ1bmN0aW9uTmFtZSA9IGZ1bmN0aW9uTmFtZTtcbnZhciBpc0NhbGxhYmxlID0gaXNDYWxsYWJsZSRoO1xudmFyIGNyZWF0ZUl0ZXJhdG9yQ29uc3RydWN0b3IgPSBjcmVhdGVJdGVyYXRvckNvbnN0cnVjdG9yJDE7XG52YXIgZ2V0UHJvdG90eXBlT2YgPSBvYmplY3RHZXRQcm90b3R5cGVPZjtcbnZhciBzZXRQcm90b3R5cGVPZiA9IG9iamVjdFNldFByb3RvdHlwZU9mO1xudmFyIHNldFRvU3RyaW5nVGFnID0gc2V0VG9TdHJpbmdUYWckMjtcbnZhciBjcmVhdGVOb25FbnVtZXJhYmxlUHJvcGVydHkkMSA9IGNyZWF0ZU5vbkVudW1lcmFibGVQcm9wZXJ0eSQ1O1xudmFyIGRlZmluZUJ1aWx0SW4gPSBkZWZpbmVCdWlsdEluJDU7XG52YXIgd2VsbEtub3duU3ltYm9sJDEgPSB3ZWxsS25vd25TeW1ib2wkYjtcbnZhciBJdGVyYXRvcnMkMSA9IGl0ZXJhdG9ycztcbnZhciBJdGVyYXRvcnNDb3JlID0gaXRlcmF0b3JzQ29yZTtcblxudmFyIFBST1BFUl9GVU5DVElPTl9OQU1FID0gRnVuY3Rpb25OYW1lLlBST1BFUjtcbnZhciBDT05GSUdVUkFCTEVfRlVOQ1RJT05fTkFNRSA9IEZ1bmN0aW9uTmFtZS5DT05GSUdVUkFCTEU7XG52YXIgSXRlcmF0b3JQcm90b3R5cGUgPSBJdGVyYXRvcnNDb3JlLkl0ZXJhdG9yUHJvdG90eXBlO1xudmFyIEJVR0dZX1NBRkFSSV9JVEVSQVRPUlMgPSBJdGVyYXRvcnNDb3JlLkJVR0dZX1NBRkFSSV9JVEVSQVRPUlM7XG52YXIgSVRFUkFUT1IkMSA9IHdlbGxLbm93blN5bWJvbCQxKCdpdGVyYXRvcicpO1xudmFyIEtFWVMgPSAna2V5cyc7XG52YXIgVkFMVUVTID0gJ3ZhbHVlcyc7XG52YXIgRU5UUklFUyA9ICdlbnRyaWVzJztcblxudmFyIHJldHVyblRoaXMgPSBmdW5jdGlvbiAoKSB7IHJldHVybiB0aGlzOyB9O1xuXG52YXIgZGVmaW5lSXRlcmF0b3IkMSA9IGZ1bmN0aW9uIChJdGVyYWJsZSwgTkFNRSwgSXRlcmF0b3JDb25zdHJ1Y3RvciwgbmV4dCwgREVGQVVMVCwgSVNfU0VULCBGT1JDRUQpIHtcbiAgY3JlYXRlSXRlcmF0b3JDb25zdHJ1Y3RvcihJdGVyYXRvckNvbnN0cnVjdG9yLCBOQU1FLCBuZXh0KTtcblxuICB2YXIgZ2V0SXRlcmF0aW9uTWV0aG9kID0gZnVuY3Rpb24gKEtJTkQpIHtcbiAgICBpZiAoS0lORCA9PT0gREVGQVVMVCAmJiBkZWZhdWx0SXRlcmF0b3IpIHJldHVybiBkZWZhdWx0SXRlcmF0b3I7XG4gICAgaWYgKCFCVUdHWV9TQUZBUklfSVRFUkFUT1JTICYmIEtJTkQgaW4gSXRlcmFibGVQcm90b3R5cGUpIHJldHVybiBJdGVyYWJsZVByb3RvdHlwZVtLSU5EXTtcbiAgICBzd2l0Y2ggKEtJTkQpIHtcbiAgICAgIGNhc2UgS0VZUzogcmV0dXJuIGZ1bmN0aW9uIGtleXMoKSB7IHJldHVybiBuZXcgSXRlcmF0b3JDb25zdHJ1Y3Rvcih0aGlzLCBLSU5EKTsgfTtcbiAgICAgIGNhc2UgVkFMVUVTOiByZXR1cm4gZnVuY3Rpb24gdmFsdWVzKCkgeyByZXR1cm4gbmV3IEl0ZXJhdG9yQ29uc3RydWN0b3IodGhpcywgS0lORCk7IH07XG4gICAgICBjYXNlIEVOVFJJRVM6IHJldHVybiBmdW5jdGlvbiBlbnRyaWVzKCkgeyByZXR1cm4gbmV3IEl0ZXJhdG9yQ29uc3RydWN0b3IodGhpcywgS0lORCk7IH07XG4gICAgfSByZXR1cm4gZnVuY3Rpb24gKCkgeyByZXR1cm4gbmV3IEl0ZXJhdG9yQ29uc3RydWN0b3IodGhpcyk7IH07XG4gIH07XG5cbiAgdmFyIFRPX1NUUklOR19UQUcgPSBOQU1FICsgJyBJdGVyYXRvcic7XG4gIHZhciBJTkNPUlJFQ1RfVkFMVUVTX05BTUUgPSBmYWxzZTtcbiAgdmFyIEl0ZXJhYmxlUHJvdG90eXBlID0gSXRlcmFibGUucHJvdG90eXBlO1xuICB2YXIgbmF0aXZlSXRlcmF0b3IgPSBJdGVyYWJsZVByb3RvdHlwZVtJVEVSQVRPUiQxXVxuICAgIHx8IEl0ZXJhYmxlUHJvdG90eXBlWydAQGl0ZXJhdG9yJ11cbiAgICB8fCBERUZBVUxUICYmIEl0ZXJhYmxlUHJvdG90eXBlW0RFRkFVTFRdO1xuICB2YXIgZGVmYXVsdEl0ZXJhdG9yID0gIUJVR0dZX1NBRkFSSV9JVEVSQVRPUlMgJiYgbmF0aXZlSXRlcmF0b3IgfHwgZ2V0SXRlcmF0aW9uTWV0aG9kKERFRkFVTFQpO1xuICB2YXIgYW55TmF0aXZlSXRlcmF0b3IgPSBOQU1FID09ICdBcnJheScgPyBJdGVyYWJsZVByb3RvdHlwZS5lbnRyaWVzIHx8IG5hdGl2ZUl0ZXJhdG9yIDogbmF0aXZlSXRlcmF0b3I7XG4gIHZhciBDdXJyZW50SXRlcmF0b3JQcm90b3R5cGUsIG1ldGhvZHMsIEtFWTtcblxuICAvLyBmaXggbmF0aXZlXG4gIGlmIChhbnlOYXRpdmVJdGVyYXRvcikge1xuICAgIEN1cnJlbnRJdGVyYXRvclByb3RvdHlwZSA9IGdldFByb3RvdHlwZU9mKGFueU5hdGl2ZUl0ZXJhdG9yLmNhbGwobmV3IEl0ZXJhYmxlKCkpKTtcbiAgICBpZiAoQ3VycmVudEl0ZXJhdG9yUHJvdG90eXBlICE9PSBPYmplY3QucHJvdG90eXBlICYmIEN1cnJlbnRJdGVyYXRvclByb3RvdHlwZS5uZXh0KSB7XG4gICAgICBpZiAoZ2V0UHJvdG90eXBlT2YoQ3VycmVudEl0ZXJhdG9yUHJvdG90eXBlKSAhPT0gSXRlcmF0b3JQcm90b3R5cGUpIHtcbiAgICAgICAgaWYgKHNldFByb3RvdHlwZU9mKSB7XG4gICAgICAgICAgc2V0UHJvdG90eXBlT2YoQ3VycmVudEl0ZXJhdG9yUHJvdG90eXBlLCBJdGVyYXRvclByb3RvdHlwZSk7XG4gICAgICAgIH0gZWxzZSBpZiAoIWlzQ2FsbGFibGUoQ3VycmVudEl0ZXJhdG9yUHJvdG90eXBlW0lURVJBVE9SJDFdKSkge1xuICAgICAgICAgIGRlZmluZUJ1aWx0SW4oQ3VycmVudEl0ZXJhdG9yUHJvdG90eXBlLCBJVEVSQVRPUiQxLCByZXR1cm5UaGlzKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gU2V0IEBAdG9TdHJpbmdUYWcgdG8gbmF0aXZlIGl0ZXJhdG9yc1xuICAgICAgc2V0VG9TdHJpbmdUYWcoQ3VycmVudEl0ZXJhdG9yUHJvdG90eXBlLCBUT19TVFJJTkdfVEFHLCB0cnVlKTtcbiAgICB9XG4gIH1cblxuICAvLyBmaXggQXJyYXkucHJvdG90eXBlLnsgdmFsdWVzLCBAQGl0ZXJhdG9yIH0ubmFtZSBpbiBWOCAvIEZGXG4gIGlmIChQUk9QRVJfRlVOQ1RJT05fTkFNRSAmJiBERUZBVUxUID09IFZBTFVFUyAmJiBuYXRpdmVJdGVyYXRvciAmJiBuYXRpdmVJdGVyYXRvci5uYW1lICE9PSBWQUxVRVMpIHtcbiAgICBpZiAoQ09ORklHVVJBQkxFX0ZVTkNUSU9OX05BTUUpIHtcbiAgICAgIGNyZWF0ZU5vbkVudW1lcmFibGVQcm9wZXJ0eSQxKEl0ZXJhYmxlUHJvdG90eXBlLCAnbmFtZScsIFZBTFVFUyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIElOQ09SUkVDVF9WQUxVRVNfTkFNRSA9IHRydWU7XG4gICAgICBkZWZhdWx0SXRlcmF0b3IgPSBmdW5jdGlvbiB2YWx1ZXMoKSB7IHJldHVybiBjYWxsJDEobmF0aXZlSXRlcmF0b3IsIHRoaXMpOyB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIGV4cG9ydCBhZGRpdGlvbmFsIG1ldGhvZHNcbiAgaWYgKERFRkFVTFQpIHtcbiAgICBtZXRob2RzID0ge1xuICAgICAgdmFsdWVzOiBnZXRJdGVyYXRpb25NZXRob2QoVkFMVUVTKSxcbiAgICAgIGtleXM6IElTX1NFVCA/IGRlZmF1bHRJdGVyYXRvciA6IGdldEl0ZXJhdGlvbk1ldGhvZChLRVlTKSxcbiAgICAgIGVudHJpZXM6IGdldEl0ZXJhdGlvbk1ldGhvZChFTlRSSUVTKVxuICAgIH07XG4gICAgaWYgKEZPUkNFRCkgZm9yIChLRVkgaW4gbWV0aG9kcykge1xuICAgICAgaWYgKEJVR0dZX1NBRkFSSV9JVEVSQVRPUlMgfHwgSU5DT1JSRUNUX1ZBTFVFU19OQU1FIHx8ICEoS0VZIGluIEl0ZXJhYmxlUHJvdG90eXBlKSkge1xuICAgICAgICBkZWZpbmVCdWlsdEluKEl0ZXJhYmxlUHJvdG90eXBlLCBLRVksIG1ldGhvZHNbS0VZXSk7XG4gICAgICB9XG4gICAgfSBlbHNlICQkMih7IHRhcmdldDogTkFNRSwgcHJvdG86IHRydWUsIGZvcmNlZDogQlVHR1lfU0FGQVJJX0lURVJBVE9SUyB8fCBJTkNPUlJFQ1RfVkFMVUVTX05BTUUgfSwgbWV0aG9kcyk7XG4gIH1cblxuICAvLyBkZWZpbmUgaXRlcmF0b3JcbiAgaWYgKEl0ZXJhYmxlUHJvdG90eXBlW0lURVJBVE9SJDFdICE9PSBkZWZhdWx0SXRlcmF0b3IpIHtcbiAgICBkZWZpbmVCdWlsdEluKEl0ZXJhYmxlUHJvdG90eXBlLCBJVEVSQVRPUiQxLCBkZWZhdWx0SXRlcmF0b3IsIHsgbmFtZTogREVGQVVMVCB9KTtcbiAgfVxuICBJdGVyYXRvcnMkMVtOQU1FXSA9IGRlZmF1bHRJdGVyYXRvcjtcblxuICByZXR1cm4gbWV0aG9kcztcbn07XG5cbnZhciB0b0luZGV4ZWRPYmplY3QgPSB0b0luZGV4ZWRPYmplY3QkNTtcbnZhciBhZGRUb1Vuc2NvcGFibGVzID0gYWRkVG9VbnNjb3BhYmxlcyQxO1xudmFyIEl0ZXJhdG9ycyA9IGl0ZXJhdG9ycztcbnZhciBJbnRlcm5hbFN0YXRlTW9kdWxlID0gaW50ZXJuYWxTdGF0ZTtcbnZhciBkZWZpbmVQcm9wZXJ0eSQxID0gb2JqZWN0RGVmaW5lUHJvcGVydHkuZjtcbnZhciBkZWZpbmVJdGVyYXRvciA9IGRlZmluZUl0ZXJhdG9yJDE7XG52YXIgREVTQ1JJUFRPUlMkMSA9IGRlc2NyaXB0b3JzO1xuXG52YXIgQVJSQVlfSVRFUkFUT1IgPSAnQXJyYXkgSXRlcmF0b3InO1xudmFyIHNldEludGVybmFsU3RhdGUgPSBJbnRlcm5hbFN0YXRlTW9kdWxlLnNldDtcbnZhciBnZXRJbnRlcm5hbFN0YXRlID0gSW50ZXJuYWxTdGF0ZU1vZHVsZS5nZXR0ZXJGb3IoQVJSQVlfSVRFUkFUT1IpO1xuXG4vLyBgQXJyYXkucHJvdG90eXBlLmVudHJpZXNgIG1ldGhvZFxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1hcnJheS5wcm90b3R5cGUuZW50cmllc1xuLy8gYEFycmF5LnByb3RvdHlwZS5rZXlzYCBtZXRob2Rcbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtYXJyYXkucHJvdG90eXBlLmtleXNcbi8vIGBBcnJheS5wcm90b3R5cGUudmFsdWVzYCBtZXRob2Rcbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtYXJyYXkucHJvdG90eXBlLnZhbHVlc1xuLy8gYEFycmF5LnByb3RvdHlwZVtAQGl0ZXJhdG9yXWAgbWV0aG9kXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLWFycmF5LnByb3RvdHlwZS1AQGl0ZXJhdG9yXG4vLyBgQ3JlYXRlQXJyYXlJdGVyYXRvcmAgaW50ZXJuYWwgbWV0aG9kXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLWNyZWF0ZWFycmF5aXRlcmF0b3JcbnZhciBlc19hcnJheV9pdGVyYXRvciA9IGRlZmluZUl0ZXJhdG9yKEFycmF5LCAnQXJyYXknLCBmdW5jdGlvbiAoaXRlcmF0ZWQsIGtpbmQpIHtcbiAgc2V0SW50ZXJuYWxTdGF0ZSh0aGlzLCB7XG4gICAgdHlwZTogQVJSQVlfSVRFUkFUT1IsXG4gICAgdGFyZ2V0OiB0b0luZGV4ZWRPYmplY3QoaXRlcmF0ZWQpLCAvLyB0YXJnZXRcbiAgICBpbmRleDogMCwgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIG5leHQgaW5kZXhcbiAgICBraW5kOiBraW5kICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGtpbmRcbiAgfSk7XG4vLyBgJUFycmF5SXRlcmF0b3JQcm90b3R5cGUlLm5leHRgIG1ldGhvZFxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy0lYXJyYXlpdGVyYXRvcnByb3RvdHlwZSUubmV4dFxufSwgZnVuY3Rpb24gKCkge1xuICB2YXIgc3RhdGUgPSBnZXRJbnRlcm5hbFN0YXRlKHRoaXMpO1xuICB2YXIgdGFyZ2V0ID0gc3RhdGUudGFyZ2V0O1xuICB2YXIga2luZCA9IHN0YXRlLmtpbmQ7XG4gIHZhciBpbmRleCA9IHN0YXRlLmluZGV4Kys7XG4gIGlmICghdGFyZ2V0IHx8IGluZGV4ID49IHRhcmdldC5sZW5ndGgpIHtcbiAgICBzdGF0ZS50YXJnZXQgPSB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIHsgdmFsdWU6IHVuZGVmaW5lZCwgZG9uZTogdHJ1ZSB9O1xuICB9XG4gIGlmIChraW5kID09ICdrZXlzJykgcmV0dXJuIHsgdmFsdWU6IGluZGV4LCBkb25lOiBmYWxzZSB9O1xuICBpZiAoa2luZCA9PSAndmFsdWVzJykgcmV0dXJuIHsgdmFsdWU6IHRhcmdldFtpbmRleF0sIGRvbmU6IGZhbHNlIH07XG4gIHJldHVybiB7IHZhbHVlOiBbaW5kZXgsIHRhcmdldFtpbmRleF1dLCBkb25lOiBmYWxzZSB9O1xufSwgJ3ZhbHVlcycpO1xuXG4vLyBhcmd1bWVudHNMaXN0W0BAaXRlcmF0b3JdIGlzICVBcnJheVByb3RvX3ZhbHVlcyVcbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtY3JlYXRldW5tYXBwZWRhcmd1bWVudHNvYmplY3Rcbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtY3JlYXRlbWFwcGVkYXJndW1lbnRzb2JqZWN0XG52YXIgdmFsdWVzID0gSXRlcmF0b3JzLkFyZ3VtZW50cyA9IEl0ZXJhdG9ycy5BcnJheTtcblxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1hcnJheS5wcm90b3R5cGUtQEB1bnNjb3BhYmxlc1xuYWRkVG9VbnNjb3BhYmxlcygna2V5cycpO1xuYWRkVG9VbnNjb3BhYmxlcygndmFsdWVzJyk7XG5hZGRUb1Vuc2NvcGFibGVzKCdlbnRyaWVzJyk7XG5cbi8vIFY4IH4gQ2hyb21lIDQ1LSBidWdcbmlmIChERVNDUklQVE9SUyQxICYmIHZhbHVlcy5uYW1lICE9PSAndmFsdWVzJykgdHJ5IHtcbiAgZGVmaW5lUHJvcGVydHkkMSh2YWx1ZXMsICduYW1lJywgeyB2YWx1ZTogJ3ZhbHVlcycgfSk7XG59IGNhdGNoIChlcnJvcikgeyAvKiBlbXB0eSAqLyB9XG5cbi8vIGl0ZXJhYmxlIERPTSBjb2xsZWN0aW9uc1xuLy8gZmxhZyAtIGBpdGVyYWJsZWAgaW50ZXJmYWNlIC0gJ2VudHJpZXMnLCAna2V5cycsICd2YWx1ZXMnLCAnZm9yRWFjaCcgbWV0aG9kc1xudmFyIGRvbUl0ZXJhYmxlcyA9IHtcbiAgQ1NTUnVsZUxpc3Q6IDAsXG4gIENTU1N0eWxlRGVjbGFyYXRpb246IDAsXG4gIENTU1ZhbHVlTGlzdDogMCxcbiAgQ2xpZW50UmVjdExpc3Q6IDAsXG4gIERPTVJlY3RMaXN0OiAwLFxuICBET01TdHJpbmdMaXN0OiAwLFxuICBET01Ub2tlbkxpc3Q6IDEsXG4gIERhdGFUcmFuc2Zlckl0ZW1MaXN0OiAwLFxuICBGaWxlTGlzdDogMCxcbiAgSFRNTEFsbENvbGxlY3Rpb246IDAsXG4gIEhUTUxDb2xsZWN0aW9uOiAwLFxuICBIVE1MRm9ybUVsZW1lbnQ6IDAsXG4gIEhUTUxTZWxlY3RFbGVtZW50OiAwLFxuICBNZWRpYUxpc3Q6IDAsXG4gIE1pbWVUeXBlQXJyYXk6IDAsXG4gIE5hbWVkTm9kZU1hcDogMCxcbiAgTm9kZUxpc3Q6IDEsXG4gIFBhaW50UmVxdWVzdExpc3Q6IDAsXG4gIFBsdWdpbjogMCxcbiAgUGx1Z2luQXJyYXk6IDAsXG4gIFNWR0xlbmd0aExpc3Q6IDAsXG4gIFNWR051bWJlckxpc3Q6IDAsXG4gIFNWR1BhdGhTZWdMaXN0OiAwLFxuICBTVkdQb2ludExpc3Q6IDAsXG4gIFNWR1N0cmluZ0xpc3Q6IDAsXG4gIFNWR1RyYW5zZm9ybUxpc3Q6IDAsXG4gIFNvdXJjZUJ1ZmZlckxpc3Q6IDAsXG4gIFN0eWxlU2hlZXRMaXN0OiAwLFxuICBUZXh0VHJhY2tDdWVMaXN0OiAwLFxuICBUZXh0VHJhY2tMaXN0OiAwLFxuICBUb3VjaExpc3Q6IDBcbn07XG5cbi8vIGluIG9sZCBXZWJLaXQgdmVyc2lvbnMsIGBlbGVtZW50LmNsYXNzTGlzdGAgaXMgbm90IGFuIGluc3RhbmNlIG9mIGdsb2JhbCBgRE9NVG9rZW5MaXN0YFxudmFyIGRvY3VtZW50Q3JlYXRlRWxlbWVudCA9IGRvY3VtZW50Q3JlYXRlRWxlbWVudCQyO1xuXG52YXIgY2xhc3NMaXN0ID0gZG9jdW1lbnRDcmVhdGVFbGVtZW50KCdzcGFuJykuY2xhc3NMaXN0O1xudmFyIERPTVRva2VuTGlzdFByb3RvdHlwZSQxID0gY2xhc3NMaXN0ICYmIGNsYXNzTGlzdC5jb25zdHJ1Y3RvciAmJiBjbGFzc0xpc3QuY29uc3RydWN0b3IucHJvdG90eXBlO1xuXG52YXIgZG9tVG9rZW5MaXN0UHJvdG90eXBlID0gRE9NVG9rZW5MaXN0UHJvdG90eXBlJDEgPT09IE9iamVjdC5wcm90b3R5cGUgPyB1bmRlZmluZWQgOiBET01Ub2tlbkxpc3RQcm90b3R5cGUkMTtcblxudmFyIGdsb2JhbCQxID0gZ2xvYmFsJGY7XG52YXIgRE9NSXRlcmFibGVzID0gZG9tSXRlcmFibGVzO1xudmFyIERPTVRva2VuTGlzdFByb3RvdHlwZSA9IGRvbVRva2VuTGlzdFByb3RvdHlwZTtcbnZhciBBcnJheUl0ZXJhdG9yTWV0aG9kcyA9IGVzX2FycmF5X2l0ZXJhdG9yO1xudmFyIGNyZWF0ZU5vbkVudW1lcmFibGVQcm9wZXJ0eSA9IGNyZWF0ZU5vbkVudW1lcmFibGVQcm9wZXJ0eSQ1O1xudmFyIHdlbGxLbm93blN5bWJvbCA9IHdlbGxLbm93blN5bWJvbCRiO1xuXG52YXIgSVRFUkFUT1IgPSB3ZWxsS25vd25TeW1ib2woJ2l0ZXJhdG9yJyk7XG52YXIgVE9fU1RSSU5HX1RBRyA9IHdlbGxLbm93blN5bWJvbCgndG9TdHJpbmdUYWcnKTtcbnZhciBBcnJheVZhbHVlcyA9IEFycmF5SXRlcmF0b3JNZXRob2RzLnZhbHVlcztcblxudmFyIGhhbmRsZVByb3RvdHlwZSA9IGZ1bmN0aW9uIChDb2xsZWN0aW9uUHJvdG90eXBlLCBDT0xMRUNUSU9OX05BTUUpIHtcbiAgaWYgKENvbGxlY3Rpb25Qcm90b3R5cGUpIHtcbiAgICAvLyBzb21lIENocm9tZSB2ZXJzaW9ucyBoYXZlIG5vbi1jb25maWd1cmFibGUgbWV0aG9kcyBvbiBET01Ub2tlbkxpc3RcbiAgICBpZiAoQ29sbGVjdGlvblByb3RvdHlwZVtJVEVSQVRPUl0gIT09IEFycmF5VmFsdWVzKSB0cnkge1xuICAgICAgY3JlYXRlTm9uRW51bWVyYWJsZVByb3BlcnR5KENvbGxlY3Rpb25Qcm90b3R5cGUsIElURVJBVE9SLCBBcnJheVZhbHVlcyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIENvbGxlY3Rpb25Qcm90b3R5cGVbSVRFUkFUT1JdID0gQXJyYXlWYWx1ZXM7XG4gICAgfVxuICAgIGlmICghQ29sbGVjdGlvblByb3RvdHlwZVtUT19TVFJJTkdfVEFHXSkge1xuICAgICAgY3JlYXRlTm9uRW51bWVyYWJsZVByb3BlcnR5KENvbGxlY3Rpb25Qcm90b3R5cGUsIFRPX1NUUklOR19UQUcsIENPTExFQ1RJT05fTkFNRSk7XG4gICAgfVxuICAgIGlmIChET01JdGVyYWJsZXNbQ09MTEVDVElPTl9OQU1FXSkgZm9yICh2YXIgTUVUSE9EX05BTUUgaW4gQXJyYXlJdGVyYXRvck1ldGhvZHMpIHtcbiAgICAgIC8vIHNvbWUgQ2hyb21lIHZlcnNpb25zIGhhdmUgbm9uLWNvbmZpZ3VyYWJsZSBtZXRob2RzIG9uIERPTVRva2VuTGlzdFxuICAgICAgaWYgKENvbGxlY3Rpb25Qcm90b3R5cGVbTUVUSE9EX05BTUVdICE9PSBBcnJheUl0ZXJhdG9yTWV0aG9kc1tNRVRIT0RfTkFNRV0pIHRyeSB7XG4gICAgICAgIGNyZWF0ZU5vbkVudW1lcmFibGVQcm9wZXJ0eShDb2xsZWN0aW9uUHJvdG90eXBlLCBNRVRIT0RfTkFNRSwgQXJyYXlJdGVyYXRvck1ldGhvZHNbTUVUSE9EX05BTUVdKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIENvbGxlY3Rpb25Qcm90b3R5cGVbTUVUSE9EX05BTUVdID0gQXJyYXlJdGVyYXRvck1ldGhvZHNbTUVUSE9EX05BTUVdO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuZm9yICh2YXIgQ09MTEVDVElPTl9OQU1FIGluIERPTUl0ZXJhYmxlcykge1xuICBoYW5kbGVQcm90b3R5cGUoZ2xvYmFsJDFbQ09MTEVDVElPTl9OQU1FXSAmJiBnbG9iYWwkMVtDT0xMRUNUSU9OX05BTUVdLnByb3RvdHlwZSwgQ09MTEVDVElPTl9OQU1FKTtcbn1cblxuaGFuZGxlUHJvdG90eXBlKERPTVRva2VuTGlzdFByb3RvdHlwZSwgJ0RPTVRva2VuTGlzdCcpO1xuXG5jb25zdCBhZ2dyZWdhdGVDZWxsID0gKHtcbiAgcmF3VmFsdWVzLFxuICBmcmFtZSxcbiAgZGVsdGEsXG4gIHF1YW50aXplT2Zmc2V0LFxuICBzdWJsYXllckNvdW50LFxuICBhZ2dyZWdhdGlvbk9wZXJhdGlvbjogX2FnZ3JlZ2F0aW9uT3BlcmF0aW9uID0gQWdncmVnYXRpb25PcGVyYXRpb24uU3VtLFxuICBzdWJsYXllckNvbWJpbmF0aW9uTW9kZTogX3N1YmxheWVyQ29tYmluYXRpb25Nb2RlID0gU3VibGF5ZXJDb21iaW5hdGlvbk1vZGUuTWF4LFxuICBtdWx0aXBsaWVyOiBfbXVsdGlwbGllciA9IFZBTFVFX01VTFRJUExJRVJcbn0pID0+IHtcbiAgaWYgKCFyYXdWYWx1ZXMpIHJldHVybiBudWxsO1xuICBjb25zdCB7XG4gICAgdmFsdWVzLFxuICAgIG1pbkNlbGxPZmZzZXQsXG4gICAgbWF4Q2VsbE9mZnNldFxuICB9ID0gZ2V0Q2VsbFZhbHVlcyhyYXdWYWx1ZXMpOyAvLyBXaGVuIHdlIHNob3VsZCBzdGFydCBjb3VudGluZyBpbiB0ZXJtcyBvZiBkYXlzL2hvdXJzLzEwZGF5cyBmcm9tIHN0YXJ0IG9mIHRpbWVcblxuICBjb25zdCBzdGFydE9mZnNldCA9IHF1YW50aXplT2Zmc2V0ICsgZnJhbWU7XG4gIGNvbnN0IGVuZE9mZnNldCA9IHN0YXJ0T2Zmc2V0ICsgZGVsdGE7XG5cbiAgaWYgKHN0YXJ0T2Zmc2V0ID4gbWF4Q2VsbE9mZnNldCB8fCBlbmRPZmZzZXQgPCBtaW5DZWxsT2Zmc2V0KSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBjb25zdCBjZWxsU3RhcnRPZmZzZXQgPSBNYXRoLm1heChzdGFydE9mZnNldCwgbWluQ2VsbE9mZnNldCk7XG4gIGNvbnN0IGNlbGxFbmRPZmZzZXQgPSBNYXRoLm1pbihlbmRPZmZzZXQsIG1heENlbGxPZmZzZXQpOyAvLyBXaGVyZSB3ZSBzb3VsZCBzdGFydCBsb29raW5nIHVwIGluIHRoZSBhcnJheSAobWluQ2VsbE9mZnNldCwgbWF4Q2VsbE9mZnNldCwgc3VibGF5ZXIwdmFsdWVBdDAsIHN1YmxheWVyMXZhbHVlQXQwLCBzdWJsYXllcjB2YWx1ZUF0MSwgc3VibGF5ZXIxdmFsdWVBdDEsIC4uLilcblxuICBjb25zdCBzdGFydEF0ID0gZ2V0Q2VsbEFycmF5SW5kZXgobWluQ2VsbE9mZnNldCwgc3VibGF5ZXJDb3VudCwgY2VsbFN0YXJ0T2Zmc2V0KTtcbiAgY29uc3QgZW5kQXQgPSBnZXRDZWxsQXJyYXlJbmRleChtaW5DZWxsT2Zmc2V0LCBzdWJsYXllckNvdW50LCBjZWxsRW5kT2Zmc2V0KTtcbiAgY29uc3QgcmF3VmFsdWVzQXJyU2xpY2UgPSB2YWx1ZXMuc2xpY2Uoc3RhcnRBdCwgZW5kQXQpOyAvLyBPbmUgYWdncmVnYXRlZCB2YWx1ZSBwZXIgc3VibGF5ZXJcblxuICBsZXQgYWdncmVnYXRlZFZhbHVlcyA9IG5ldyBBcnJheShzdWJsYXllckNvdW50KS5maWxsKDApO1xuICBsZXQgbnVtVmFsdWVzID0gMDtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IHJhd1ZhbHVlc0FyclNsaWNlLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3Qgc3VibGF5ZXJJbmRleCA9IGkgJSBzdWJsYXllckNvdW50O1xuICAgIGNvbnN0IHJhd1ZhbHVlID0gcmF3VmFsdWVzQXJyU2xpY2VbaV07XG5cbiAgICBpZiAocmF3VmFsdWUgIT09IG51bGwgJiYgcmF3VmFsdWUgIT09IHVuZGVmaW5lZCAmJiAhaXNOYU4ocmF3VmFsdWUpICYmIHJhd1ZhbHVlICE9PSAwKSB7XG4gICAgICBhZ2dyZWdhdGVkVmFsdWVzW3N1YmxheWVySW5kZXhdICs9IHJhd1ZhbHVlO1xuICAgICAgaWYgKHN1YmxheWVySW5kZXggPT09IDApIG51bVZhbHVlcysrO1xuICAgIH1cbiAgfVxuXG4gIGlmIChfYWdncmVnYXRpb25PcGVyYXRpb24gPT09IEFnZ3JlZ2F0aW9uT3BlcmF0aW9uLkF2ZyAmJiBudW1WYWx1ZXMgPiAwKSB7XG4gICAgYWdncmVnYXRlZFZhbHVlcyA9IGFnZ3JlZ2F0ZWRWYWx1ZXMubWFwKHN1YmxheWVyVmFsdWUgPT4gc3VibGF5ZXJWYWx1ZSAvIG51bVZhbHVlcyk7XG4gIH1cblxuICBjb25zdCByZWFsVmFsdWVzID0gZ2V0UmVhbFZhbHVlcyhhZ2dyZWdhdGVkVmFsdWVzLCB7XG4gICAgbXVsdGlwbGllcjogX211bHRpcGxpZXJcbiAgfSk7XG5cbiAgaWYgKF9zdWJsYXllckNvbWJpbmF0aW9uTW9kZSA9PT0gU3VibGF5ZXJDb21iaW5hdGlvbk1vZGUuVGltZUNvbXBhcmUpIHtcbiAgICByZXR1cm4gW3JlYWxWYWx1ZXNbMV0gLSByZWFsVmFsdWVzWzBdXTtcbiAgfVxuXG4gIHJldHVybiByZWFsVmFsdWVzO1xufTtcblxudmFyIERFU0NSSVBUT1JTID0gZGVzY3JpcHRvcnM7XG52YXIgdW5jdXJyeVRoaXMkMSA9IGZ1bmN0aW9uVW5jdXJyeVRoaXM7XG52YXIgY2FsbCA9IGZ1bmN0aW9uQ2FsbDtcbnZhciBmYWlscyA9IGZhaWxzJGo7XG52YXIgb2JqZWN0S2V5cyA9IG9iamVjdEtleXMkMjtcbnZhciBnZXRPd25Qcm9wZXJ0eVN5bWJvbHNNb2R1bGUgPSBvYmplY3RHZXRPd25Qcm9wZXJ0eVN5bWJvbHM7XG52YXIgcHJvcGVydHlJc0VudW1lcmFibGVNb2R1bGUgPSBvYmplY3RQcm9wZXJ0eUlzRW51bWVyYWJsZTtcbnZhciB0b09iamVjdCA9IHRvT2JqZWN0JDM7XG52YXIgSW5kZXhlZE9iamVjdCA9IGluZGV4ZWRPYmplY3Q7XG5cbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBlcy14L25vLW9iamVjdC1hc3NpZ24gLS0gc2FmZVxudmFyICRhc3NpZ24gPSBPYmplY3QuYXNzaWduO1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGVzLXgvbm8tb2JqZWN0LWRlZmluZXByb3BlcnR5IC0tIHJlcXVpcmVkIGZvciB0ZXN0aW5nXG52YXIgZGVmaW5lUHJvcGVydHkgPSBPYmplY3QuZGVmaW5lUHJvcGVydHk7XG52YXIgY29uY2F0ID0gdW5jdXJyeVRoaXMkMShbXS5jb25jYXQpO1xuXG4vLyBgT2JqZWN0LmFzc2lnbmAgbWV0aG9kXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLW9iamVjdC5hc3NpZ25cbnZhciBvYmplY3RBc3NpZ24gPSAhJGFzc2lnbiB8fCBmYWlscyhmdW5jdGlvbiAoKSB7XG4gIC8vIHNob3VsZCBoYXZlIGNvcnJlY3Qgb3JkZXIgb2Ygb3BlcmF0aW9ucyAoRWRnZSBidWcpXG4gIGlmIChERVNDUklQVE9SUyAmJiAkYXNzaWduKHsgYjogMSB9LCAkYXNzaWduKGRlZmluZVByb3BlcnR5KHt9LCAnYScsIHtcbiAgICBlbnVtZXJhYmxlOiB0cnVlLFxuICAgIGdldDogZnVuY3Rpb24gKCkge1xuICAgICAgZGVmaW5lUHJvcGVydHkodGhpcywgJ2InLCB7XG4gICAgICAgIHZhbHVlOiAzLFxuICAgICAgICBlbnVtZXJhYmxlOiBmYWxzZVxuICAgICAgfSk7XG4gICAgfVxuICB9KSwgeyBiOiAyIH0pKS5iICE9PSAxKSByZXR1cm4gdHJ1ZTtcbiAgLy8gc2hvdWxkIHdvcmsgd2l0aCBzeW1ib2xzIGFuZCBzaG91bGQgaGF2ZSBkZXRlcm1pbmlzdGljIHByb3BlcnR5IG9yZGVyIChWOCBidWcpXG4gIHZhciBBID0ge307XG4gIHZhciBCID0ge307XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBlcy14L25vLXN5bWJvbCAtLSBzYWZlXG4gIHZhciBzeW1ib2wgPSBTeW1ib2woKTtcbiAgdmFyIGFscGhhYmV0ID0gJ2FiY2RlZmdoaWprbG1ub3BxcnN0JztcbiAgQVtzeW1ib2xdID0gNztcbiAgYWxwaGFiZXQuc3BsaXQoJycpLmZvckVhY2goZnVuY3Rpb24gKGNocikgeyBCW2Nocl0gPSBjaHI7IH0pO1xuICByZXR1cm4gJGFzc2lnbih7fSwgQSlbc3ltYm9sXSAhPSA3IHx8IG9iamVjdEtleXMoJGFzc2lnbih7fSwgQikpLmpvaW4oJycpICE9IGFscGhhYmV0O1xufSkgPyBmdW5jdGlvbiBhc3NpZ24odGFyZ2V0LCBzb3VyY2UpIHsgLy8gZXNsaW50LWRpc2FibGUtbGluZSBuby11bnVzZWQtdmFycyAtLSByZXF1aXJlZCBmb3IgYC5sZW5ndGhgXG4gIHZhciBUID0gdG9PYmplY3QodGFyZ2V0KTtcbiAgdmFyIGFyZ3VtZW50c0xlbmd0aCA9IGFyZ3VtZW50cy5sZW5ndGg7XG4gIHZhciBpbmRleCA9IDE7XG4gIHZhciBnZXRPd25Qcm9wZXJ0eVN5bWJvbHMgPSBnZXRPd25Qcm9wZXJ0eVN5bWJvbHNNb2R1bGUuZjtcbiAgdmFyIHByb3BlcnR5SXNFbnVtZXJhYmxlID0gcHJvcGVydHlJc0VudW1lcmFibGVNb2R1bGUuZjtcbiAgd2hpbGUgKGFyZ3VtZW50c0xlbmd0aCA+IGluZGV4KSB7XG4gICAgdmFyIFMgPSBJbmRleGVkT2JqZWN0KGFyZ3VtZW50c1tpbmRleCsrXSk7XG4gICAgdmFyIGtleXMgPSBnZXRPd25Qcm9wZXJ0eVN5bWJvbHMgPyBjb25jYXQob2JqZWN0S2V5cyhTKSwgZ2V0T3duUHJvcGVydHlTeW1ib2xzKFMpKSA6IG9iamVjdEtleXMoUyk7XG4gICAgdmFyIGxlbmd0aCA9IGtleXMubGVuZ3RoO1xuICAgIHZhciBqID0gMDtcbiAgICB2YXIga2V5O1xuICAgIHdoaWxlIChsZW5ndGggPiBqKSB7XG4gICAgICBrZXkgPSBrZXlzW2orK107XG4gICAgICBpZiAoIURFU0NSSVBUT1JTIHx8IGNhbGwocHJvcGVydHlJc0VudW1lcmFibGUsIFMsIGtleSkpIFRba2V5XSA9IFNba2V5XTtcbiAgICB9XG4gIH0gcmV0dXJuIFQ7XG59IDogJGFzc2lnbjtcblxudmFyICQkMSA9IF9leHBvcnQ7XG52YXIgYXNzaWduID0gb2JqZWN0QXNzaWduO1xuXG4vLyBgT2JqZWN0LmFzc2lnbmAgbWV0aG9kXG4vLyBodHRwczovL3RjMzkuZXMvZWNtYTI2Mi8jc2VjLW9iamVjdC5hc3NpZ25cbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBlcy14L25vLW9iamVjdC1hc3NpZ24gLS0gcmVxdWlyZWQgZm9yIHRlc3RpbmdcbiQkMSh7IHRhcmdldDogJ09iamVjdCcsIHN0YXQ6IHRydWUsIGFyaXR5OiAyLCBmb3JjZWQ6IE9iamVjdC5hc3NpZ24gIT09IGFzc2lnbiB9LCB7XG4gIGFzc2lnbjogYXNzaWduXG59KTtcblxudmFyIHRvSW50ZWdlck9ySW5maW5pdHkgPSB0b0ludGVnZXJPckluZmluaXR5JDQ7XG52YXIgdG9TdHJpbmckMSA9IHRvU3RyaW5nJDc7XG52YXIgcmVxdWlyZU9iamVjdENvZXJjaWJsZSQxID0gcmVxdWlyZU9iamVjdENvZXJjaWJsZSQ3O1xuXG52YXIgJFJhbmdlRXJyb3IgPSBSYW5nZUVycm9yO1xuXG4vLyBgU3RyaW5nLnByb3RvdHlwZS5yZXBlYXRgIG1ldGhvZCBpbXBsZW1lbnRhdGlvblxuLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1zdHJpbmcucHJvdG90eXBlLnJlcGVhdFxudmFyIHN0cmluZ1JlcGVhdCA9IGZ1bmN0aW9uIHJlcGVhdChjb3VudCkge1xuICB2YXIgc3RyID0gdG9TdHJpbmckMShyZXF1aXJlT2JqZWN0Q29lcmNpYmxlJDEodGhpcykpO1xuICB2YXIgcmVzdWx0ID0gJyc7XG4gIHZhciBuID0gdG9JbnRlZ2VyT3JJbmZpbml0eShjb3VudCk7XG4gIGlmIChuIDwgMCB8fCBuID09IEluZmluaXR5KSB0aHJvdyAkUmFuZ2VFcnJvcignV3JvbmcgbnVtYmVyIG9mIHJlcGV0aXRpb25zJyk7XG4gIGZvciAoO24gPiAwOyAobiA+Pj49IDEpICYmIChzdHIgKz0gc3RyKSkgaWYgKG4gJiAxKSByZXN1bHQgKz0gc3RyO1xuICByZXR1cm4gcmVzdWx0O1xufTtcblxuLy8gaHR0cHM6Ly9naXRodWIuY29tL3RjMzkvcHJvcG9zYWwtc3RyaW5nLXBhZC1zdGFydC1lbmRcbnZhciB1bmN1cnJ5VGhpcyA9IGZ1bmN0aW9uVW5jdXJyeVRoaXM7XG52YXIgdG9MZW5ndGggPSB0b0xlbmd0aCQzO1xudmFyIHRvU3RyaW5nID0gdG9TdHJpbmckNztcbnZhciAkcmVwZWF0ID0gc3RyaW5nUmVwZWF0O1xudmFyIHJlcXVpcmVPYmplY3RDb2VyY2libGUgPSByZXF1aXJlT2JqZWN0Q29lcmNpYmxlJDc7XG5cbnZhciByZXBlYXQgPSB1bmN1cnJ5VGhpcygkcmVwZWF0KTtcbnZhciBzdHJpbmdTbGljZSA9IHVuY3VycnlUaGlzKCcnLnNsaWNlKTtcbnZhciBjZWlsID0gTWF0aC5jZWlsO1xuXG4vLyBgU3RyaW5nLnByb3RvdHlwZS57IHBhZFN0YXJ0LCBwYWRFbmQgfWAgbWV0aG9kcyBpbXBsZW1lbnRhdGlvblxudmFyIGNyZWF0ZU1ldGhvZCA9IGZ1bmN0aW9uIChJU19FTkQpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uICgkdGhpcywgbWF4TGVuZ3RoLCBmaWxsU3RyaW5nKSB7XG4gICAgdmFyIFMgPSB0b1N0cmluZyhyZXF1aXJlT2JqZWN0Q29lcmNpYmxlKCR0aGlzKSk7XG4gICAgdmFyIGludE1heExlbmd0aCA9IHRvTGVuZ3RoKG1heExlbmd0aCk7XG4gICAgdmFyIHN0cmluZ0xlbmd0aCA9IFMubGVuZ3RoO1xuICAgIHZhciBmaWxsU3RyID0gZmlsbFN0cmluZyA9PT0gdW5kZWZpbmVkID8gJyAnIDogdG9TdHJpbmcoZmlsbFN0cmluZyk7XG4gICAgdmFyIGZpbGxMZW4sIHN0cmluZ0ZpbGxlcjtcbiAgICBpZiAoaW50TWF4TGVuZ3RoIDw9IHN0cmluZ0xlbmd0aCB8fCBmaWxsU3RyID09ICcnKSByZXR1cm4gUztcbiAgICBmaWxsTGVuID0gaW50TWF4TGVuZ3RoIC0gc3RyaW5nTGVuZ3RoO1xuICAgIHN0cmluZ0ZpbGxlciA9IHJlcGVhdChmaWxsU3RyLCBjZWlsKGZpbGxMZW4gLyBmaWxsU3RyLmxlbmd0aCkpO1xuICAgIGlmIChzdHJpbmdGaWxsZXIubGVuZ3RoID4gZmlsbExlbikgc3RyaW5nRmlsbGVyID0gc3RyaW5nU2xpY2Uoc3RyaW5nRmlsbGVyLCAwLCBmaWxsTGVuKTtcbiAgICByZXR1cm4gSVNfRU5EID8gUyArIHN0cmluZ0ZpbGxlciA6IHN0cmluZ0ZpbGxlciArIFM7XG4gIH07XG59O1xuXG52YXIgc3RyaW5nUGFkID0ge1xuICAvLyBgU3RyaW5nLnByb3RvdHlwZS5wYWRTdGFydGAgbWV0aG9kXG4gIC8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtc3RyaW5nLnByb3RvdHlwZS5wYWRzdGFydFxuICBzdGFydDogY3JlYXRlTWV0aG9kKGZhbHNlKSxcbiAgLy8gYFN0cmluZy5wcm90b3R5cGUucGFkRW5kYCBtZXRob2RcbiAgLy8gaHR0cHM6Ly90YzM5LmVzL2VjbWEyNjIvI3NlYy1zdHJpbmcucHJvdG90eXBlLnBhZGVuZFxuICBlbmQ6IGNyZWF0ZU1ldGhvZCh0cnVlKVxufTtcblxuLy8gaHR0cHM6Ly9naXRodWIuY29tL3psb2lyb2NrL2NvcmUtanMvaXNzdWVzLzI4MFxudmFyIHVzZXJBZ2VudCA9IGVuZ2luZVVzZXJBZ2VudDtcblxudmFyIHN0cmluZ1BhZFdlYmtpdEJ1ZyA9IC9WZXJzaW9uXFwvMTAoPzpcXC5cXGQrKXsxLDJ9KD86IFtcXHcuL10rKT8oPzogTW9iaWxlXFwvXFx3Kyk/IFNhZmFyaVxcLy8udGVzdCh1c2VyQWdlbnQpO1xuXG52YXIgJCA9IF9leHBvcnQ7XG52YXIgJHBhZFN0YXJ0ID0gc3RyaW5nUGFkLnN0YXJ0O1xudmFyIFdFQktJVF9CVUcgPSBzdHJpbmdQYWRXZWJraXRCdWc7XG5cbi8vIGBTdHJpbmcucHJvdG90eXBlLnBhZFN0YXJ0YCBtZXRob2Rcbi8vIGh0dHBzOi8vdGMzOS5lcy9lY21hMjYyLyNzZWMtc3RyaW5nLnByb3RvdHlwZS5wYWRzdGFydFxuJCh7IHRhcmdldDogJ1N0cmluZycsIHByb3RvOiB0cnVlLCBmb3JjZWQ6IFdFQktJVF9CVUcgfSwge1xuICBwYWRTdGFydDogZnVuY3Rpb24gcGFkU3RhcnQobWF4TGVuZ3RoIC8qICwgZmlsbFN0cmluZyA9ICcgJyAqLykge1xuICAgIHJldHVybiAkcGFkU3RhcnQodGhpcywgbWF4TGVuZ3RoLCBhcmd1bWVudHMubGVuZ3RoID4gMSA/IGFyZ3VtZW50c1sxXSA6IHVuZGVmaW5lZCk7XG4gIH1cbn0pO1xuXG5jb25zdCBnZXRDZWxsQ29vcmRzID0gKHRpbGVCQm94LCBjZWxsLCBudW1Db2xzKSA9PiB7XG4gIGNvbnN0IGNvbCA9IGNlbGwgJSBudW1Db2xzO1xuICBjb25zdCByb3cgPSBNYXRoLmZsb29yKGNlbGwgLyBudW1Db2xzKTtcbiAgY29uc3QgW21pblgsIG1pblksIG1heFgsIG1heFldID0gdGlsZUJCb3g7XG4gIGNvbnN0IHdpZHRoID0gbWF4WCAtIG1pblg7XG4gIGNvbnN0IGhlaWdodCA9IG1heFkgLSBtaW5ZO1xuICByZXR1cm4ge1xuICAgIGNvbCxcbiAgICByb3csXG4gICAgd2lkdGgsXG4gICAgaGVpZ2h0XG4gIH07XG59O1xuXG5jb25zdCBnZXRQb2ludEZlYXR1cmUgPSAoe1xuICB0aWxlQkJveCxcbiAgY2VsbCxcbiAgbnVtQ29scyxcbiAgbnVtUm93cyxcbiAgYWRkTWV0YVxufSkgPT4ge1xuICBjb25zdCBbbWluWCwgbWluWV0gPSB0aWxlQkJveDtcbiAgY29uc3Qge1xuICAgIGNvbCxcbiAgICByb3csXG4gICAgd2lkdGgsXG4gICAgaGVpZ2h0XG4gIH0gPSBnZXRDZWxsQ29vcmRzKHRpbGVCQm94LCBjZWxsLCBudW1Db2xzKTtcbiAgY29uc3QgcG9pbnRNaW5YID0gbWluWCArIGNvbCAvIG51bUNvbHMgKiB3aWR0aDtcbiAgY29uc3QgcG9pbnRNaW5ZID0gbWluWSArIHJvdyAvIG51bVJvd3MgKiBoZWlnaHQ7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSBhZGRNZXRhID8ge1xuICAgIF9jb2w6IGNvbCxcbiAgICBfcm93OiByb3dcbiAgfSA6IHt9O1xuICByZXR1cm4ge1xuICAgIHR5cGU6ICdGZWF0dXJlJyxcbiAgICBwcm9wZXJ0aWVzLFxuICAgIGdlb21ldHJ5OiB7XG4gICAgICB0eXBlOiAnUG9pbnQnLFxuICAgICAgY29vcmRpbmF0ZXM6IFtwb2ludE1pblgsIHBvaW50TWluWV1cbiAgICB9XG4gIH07XG59O1xuXG5jb25zdCBnZXRSZWN0YW5nbGVGZWF0dXJlID0gKHtcbiAgdGlsZUJCb3gsXG4gIGNlbGwsXG4gIG51bUNvbHMsXG4gIG51bVJvd3MsXG4gIGFkZE1ldGFcbn0pID0+IHtcbiAgY29uc3QgW21pblgsIG1pblldID0gdGlsZUJCb3g7XG4gIGNvbnN0IHtcbiAgICBjb2wsXG4gICAgcm93LFxuICAgIHdpZHRoLFxuICAgIGhlaWdodFxuICB9ID0gZ2V0Q2VsbENvb3Jkcyh0aWxlQkJveCwgY2VsbCwgbnVtQ29scyk7XG4gIGNvbnN0IHNxdWFyZU1pblggPSBtaW5YICsgY29sIC8gbnVtQ29scyAqIHdpZHRoO1xuICBjb25zdCBzcXVhcmVNaW5ZID0gbWluWSArIHJvdyAvIG51bVJvd3MgKiBoZWlnaHQ7XG4gIGNvbnN0IHNxdWFyZU1heFggPSBtaW5YICsgKGNvbCArIDEpIC8gbnVtQ29scyAqIHdpZHRoO1xuICBjb25zdCBzcXVhcmVNYXhZID0gbWluWSArIChyb3cgKyAxKSAvIG51bVJvd3MgKiBoZWlnaHQ7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSBhZGRNZXRhID8ge1xuICAgIF9jb2w6IGNvbCxcbiAgICBfcm93OiByb3dcbiAgfSA6IHt9O1xuICByZXR1cm4ge1xuICAgIHR5cGU6ICdGZWF0dXJlJyxcbiAgICBwcm9wZXJ0aWVzLFxuICAgIGdlb21ldHJ5OiB7XG4gICAgICB0eXBlOiAnUG9seWdvbicsXG4gICAgICBjb29yZGluYXRlczogW1tbc3F1YXJlTWluWCwgc3F1YXJlTWluWV0sIFtzcXVhcmVNYXhYLCBzcXVhcmVNaW5ZXSwgW3NxdWFyZU1heFgsIHNxdWFyZU1heFldLCBbc3F1YXJlTWluWCwgc3F1YXJlTWF4WV0sIFtzcXVhcmVNaW5YLCBzcXVhcmVNaW5ZXV1dXG4gICAgfVxuICB9O1xufTtcblxuY29uc3QgZ2V0RmVhdHVyZSA9IGZlYXR1cmVQYXJhbXMgPT4ge1xuICBjb25zdCBmZWF0dXJlID0gZmVhdHVyZVBhcmFtcy5nZW9tVHlwZSA9PT0gR2VvbVR5cGUucG9pbnQgPyBnZXRQb2ludEZlYXR1cmUoZmVhdHVyZVBhcmFtcykgOiBnZXRSZWN0YW5nbGVGZWF0dXJlKGZlYXR1cmVQYXJhbXMpO1xuICBmZWF0dXJlLmlkID0gZmVhdHVyZVBhcmFtcy5pZDtcbiAgcmV0dXJuIGZlYXR1cmU7XG59O1xuXG5jb25zdCB3cml0ZVZhbHVlVG9GZWF0dXJlID0gKHF1YW50aXplZFRhaWwsIHZhbHVlVG9Xcml0ZSwgZmVhdHVyZSkgPT4ge1xuICBjb25zdCBwcm9wZXJ0aWVzS2V5ID0gcXVhbnRpemVkVGFpbC50b1N0cmluZygpO1xuXG4gIGlmICh2YWx1ZVRvV3JpdGUgIT09IHVuZGVmaW5lZCkge1xuICAgIC8vIFNhdmluZyBOYU4gaW4gZmVhdHVyZSBwcm9wZXJ0eSB2YWx1ZSBjb21wbGljYXRlcyB0aGUgZXhwcmVzc2lvbnMgYSBsb3QsIHNhdmluZyBudWxsIGluc3RlYWRcbiAgICBmZWF0dXJlLnByb3BlcnRpZXNbcHJvcGVydGllc0tleV0gPSBpc05hTih2YWx1ZVRvV3JpdGUpID8gbnVsbCA6IHZhbHVlVG9Xcml0ZTtcbiAgfVxufTsgLy8gR2l2ZW4gYnJlYWtzIFtbMCwgMTAsIDIwLCAzMF0sIFstMTUsIC01LCAwLCA1LCAxNV1dOlxuLy9cbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfCAgIHwgICB8ICAgfCAgIHxcbi8vICBpZiBmaXJzdCBkYXRhc2V0IHNlbGVjdGVkICAgICBbICAgMCwgMTAsIDIwLCAzMCAgXVxuLy8gICAgaW5kZXggcmV0dXJuZWQgaXM6ICAgICAgICAgICAgMCB8IDEgfCAyIHwgMyB8IDQgfFxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB8ICAgfCAgIHwgICB8ICAgfFxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB8XG4vLyBOb3RlOiBpZiB2YWx1ZSBpcyBFWEFDVExZIDAsIGZlYXR1cmUgaXMgZW50aXJlbHkgb21pdHRlZFxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB8XG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHxcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB1bmRlZmluZWRcbi8vXG4vLyAgaWYgMm5kIGRhdGFzZXQgc2VsZWN0ZWQgICAgICAgWyAtMTUsIC01LCAgMCwgIDUsIDE1XVxuLy8gICAgaW5kZXggcmV0dXJuZWQgaXM6ICAgICAgICAgICAgMCB8IDEgfCAyIHwgMyB8IDQgfCA1XG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHwgICB8ICAgfCAgIHwgICB8XG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfFxuLy8gTm90ZTogaWYgdmFsdWUgaXMgRVhBQ1RMWSAwLCBmZWF0dXJlIGlzIGVudGlyZWx5IG9taXR0ZWRcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB8XG4vLyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfFxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB1bmRlZmluZWRcbi8vXG5cblxuY29uc3QgZ2V0QnVja2V0SW5kZXggPSAoYnJlYWtzLCB2YWx1ZSkgPT4ge1xuICBsZXQgY3VycmVudEJ1Y2tldEluZGV4O1xuICBpZiAoaXNOYU4odmFsdWUpKSByZXR1cm4gMDtcblxuICBmb3IgKGxldCBidWNrZXRJbmRleCA9IDA7IGJ1Y2tldEluZGV4IDwgYnJlYWtzLmxlbmd0aCArIDE7IGJ1Y2tldEluZGV4KyspIHtcbiAgICBjb25zdCBzdG9wVmFsdWUgPSBicmVha3NbYnVja2V0SW5kZXhdICE9PSB1bmRlZmluZWQgPyBicmVha3NbYnVja2V0SW5kZXhdIDogTnVtYmVyLlBPU0lUSVZFX0lORklOSVRZO1xuXG4gICAgaWYgKHZhbHVlIDw9IHN0b3BWYWx1ZSkge1xuICAgICAgY3VycmVudEJ1Y2tldEluZGV4ID0gYnVja2V0SW5kZXg7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICBpZiAoY3VycmVudEJ1Y2tldEluZGV4ID09PSB1bmRlZmluZWQpIHtcbiAgICBjdXJyZW50QnVja2V0SW5kZXggPSBicmVha3MubGVuZ3RoO1xuICB9XG5cbiAgcmV0dXJuIGN1cnJlbnRCdWNrZXRJbmRleDtcbn07XG5cbmNvbnN0IGdldFZhbHVlID0gKHJlYWxWYWx1ZXNTdW0sIGJyZWFrcykgPT4ge1xuICBpZiAocmVhbFZhbHVlc1N1bSA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIGJyZWFrcyA/IGdldEJ1Y2tldEluZGV4KGJyZWFrc1swXSwgcmVhbFZhbHVlc1N1bSkgOiByZWFsVmFsdWVzU3VtO1xufTtcblxuY29uc3QgZ2V0Q29tcGFyZVZhbHVlID0gKGRhdGFzZXRzSGlnaGVzdFJlYWxWYWx1ZSwgZGF0YXNldHNIaWdoZXN0UmVhbFZhbHVlSW5kZXgsIGJyZWFrcykgPT4ge1xuICBpZiAoZGF0YXNldHNIaWdoZXN0UmVhbFZhbHVlID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGlmIChicmVha3MpIHtcbiAgICAvLyBvZmZzZXQgZWFjaCBkYXRhc2V0IGJ5IDEwICsgYWRkIGFjdHVhbCBidWNrZXQgdmFsdWVcbiAgICByZXR1cm4gZGF0YXNldHNIaWdoZXN0UmVhbFZhbHVlSW5kZXggKiAxMCArIGdldEJ1Y2tldEluZGV4KGJyZWFrc1tkYXRhc2V0c0hpZ2hlc3RSZWFsVmFsdWVJbmRleF0sIGRhdGFzZXRzSGlnaGVzdFJlYWxWYWx1ZSk7XG4gIH0gZWxzZSB7XG4gICAgLy8gb25seSB1c2VmdWwgZm9yIGRlYnVnXG4gICAgcmV0dXJuIGAke2RhdGFzZXRzSGlnaGVzdFJlYWxWYWx1ZUluZGV4fTske2RhdGFzZXRzSGlnaGVzdFJlYWxWYWx1ZX1gO1xuICB9XG59O1xuXG5jb25zdCBnZXRCaXZhcmlhdGVWYWx1ZSA9IChyZWFsVmFsdWVzLCBicmVha3MpID0+IHtcbiAgaWYgKHJlYWxWYWx1ZXNbMF0gPT09IDAgJiYgcmVhbFZhbHVlc1sxXSA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBpZiAoYnJlYWtzKSB7XG4gICAgLy8gIHk6IGRhdGFzZXRCXG4gICAgLy9cbiAgICAvLyAgIHwgICAgMCB8IDBcbiAgICAvLyAgIHwgICAtLSh1KS0tKy0tLSstLS0rLS0tK1xuICAgIC8vICAgfCAgICAwIHwgMSB8IDIgfCAzIHwgNCB8XG4gICAgLy8gICB8ICAgICAgKy0tLSstLS0rLS0tKy0tLStcbiAgICAvLyAgIHYgICAgICB8IDUgfCA2IHwgNyB8IDggfFxuICAgIC8vICAgICAgICAgICstLS0rLS0tKy0tLSstLS0rXG4gICAgLy8gICAgICAgICAgfCA5IHwgMTB8IDExfCAxMnxcbiAgICAvLyAgICAgICAgICArLS0tKy0tLSstLS0rLS0tK1xuICAgIC8vICAgICAgICAgIHwgMTN8IDE0fCAxNXwgMTZ8XG4gICAgLy8gICAgICAgICAgKy0tLSstLS0rLS0tKy0tLStcbiAgICAvLyAgICAgICAgICAtLS0tLS0tLS0tLS0tLT4geDogZGF0YXNldEFcbiAgICAvL1xuICAgIGNvbnN0IHZhbHVlQSA9IGdldEJ1Y2tldEluZGV4KGJyZWFrc1swXSwgcmVhbFZhbHVlc1swXSk7XG4gICAgY29uc3QgdmFsdWVCID0gZ2V0QnVja2V0SW5kZXgoYnJlYWtzWzFdLCByZWFsVmFsdWVzWzFdKTsgLy8gfHwgMTogV2UgbmV2ZXIgd2FudCBhIGJ1Y2tldCBvZiAwIC0gdmFsdWVzIGJlbG93IGZpcnN0IGJyZWFrIGFyZSBub3QgdXNlZCBpbiBiaXZhcmlhdGVcblxuICAgIGNvbnN0IGNvbEluZGV4ID0gKHZhbHVlQSB8fCAxKSAtIDE7XG4gICAgY29uc3Qgcm93SW5kZXggPSAodmFsdWVCIHx8IDEpIC0gMTtcbiAgICBjb25zdCBpbmRleCA9IHJvd0luZGV4ICogNCArIGNvbEluZGV4OyAvLyBvZmZzZXQgYnkgb25lIGJlY2F1c2UgdmFsdWVzIHN0YXJ0IGF0IDEgKDAgcmVzZXJ2ZWQgZm9yIHZhbHVlcyA8IG1pbiB2YWx1ZSlcblxuICAgIHJldHVybiBpbmRleCArIDE7XG4gIH0gZWxzZSB7XG4gICAgLy8gb25seSB1c2VmdWwgZm9yIGRlYnVnXG4gICAgcmV0dXJuIGAke3JlYWxWYWx1ZXNbMF19OyR7cmVhbFZhbHVlc1sxXX1gO1xuICB9XG59O1xuXG5jb25zdCBnZXRUaW1lQ29tcGFyZVZhbHVlID0gKHJlYWxWYWx1ZXMsIGJyZWFrcykgPT4ge1xuICBjb25zdCBkZWx0YSA9IHJlYWxWYWx1ZXNbMV0gLSByZWFsVmFsdWVzWzBdO1xuICBpZiAoZGVsdGEgPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgaWYgKGJyZWFrcykge1xuICAgIHJldHVybiBnZXRCdWNrZXRJbmRleChicmVha3NbMF0sIGRlbHRhKTtcbiAgfVxuXG4gIHJldHVybiBkZWx0YTtcbn07XG5cbmNvbnN0IGdldEN1bXVsYXRpdmVWYWx1ZSA9IChyZWFsVmFsdWVzU3VtLCBjdW11bGF0aXZlVmFsdWVzUGFkZGVkU3RyaW5ncykgPT4ge1xuICBpZiAocmVhbFZhbHVlc1N1bSA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIGN1bXVsYXRpdmVWYWx1ZXNQYWRkZWRTdHJpbmdzLmpvaW4oJycpO1xufTtcblxuY29uc3QgZXJyID0gbXNnID0+IHtcbiAgY29uc29sZS5lcnJvcignNHctYWdnOjonLCBtc2cpO1xuICB0aHJvdyBuZXcgRXJyb3IoYDR3LWFnZzo6JHttc2d9YCk7XG59O1xuXG5mdW5jdGlvbiBhZ2dyZWdhdGUoaW50QXJyYXksIG9wdGlvbnMpIHtcbiAgY29uc3Qge1xuICAgIHF1YW50aXplT2Zmc2V0ID0gMCxcbiAgICB0aWxlQkJveCxcbiAgICB4LFxuICAgIHksXG4gICAgZGVsdGEgPSAzMCxcbiAgICBnZW9tVHlwZSA9IEdlb21UeXBlLnJlY3RhbmdsZSxcbiAgICBzaW5nbGVGcmFtZSxcbiAgICBpbnRlcmFjdGl2ZSxcbiAgICBzdWJsYXllckJyZWFrcyxcbiAgICBzdWJsYXllckNvdW50LFxuICAgIHN1YmxheWVyQ29tYmluYXRpb25Nb2RlLFxuICAgIHN1YmxheWVyVmlzaWJpbGl0eSxcbiAgICBhZ2dyZWdhdGlvbk9wZXJhdGlvblxuICB9ID0gb3B0aW9ucztcblxuICBpZiAoc3VibGF5ZXJDb21iaW5hdGlvbk1vZGUgPT09IFN1YmxheWVyQ29tYmluYXRpb25Nb2RlLk5vbmUgJiYgc3VibGF5ZXJDb3VudCA+IDEpIHtcbiAgICBlcnIoJ011bHRpcGxlIHN1YmxheWVycyBidXQgbm8gcHJvcGVyIGNvbWJpbmF0aW9uIG1vZGUgc2V0Jyk7XG4gIH1cblxuICBpZiAoc3VibGF5ZXJCcmVha3MgJiYgc3VibGF5ZXJCcmVha3MubGVuZ3RoICE9PSBzdWJsYXllckNvdW50ICYmIChzdWJsYXllckNvbWJpbmF0aW9uTW9kZSA9PT0gU3VibGF5ZXJDb21iaW5hdGlvbk1vZGUuTWF4IHx8IHN1YmxheWVyQ29tYmluYXRpb25Nb2RlID09PSBTdWJsYXllckNvbWJpbmF0aW9uTW9kZS5CaXZhcmlhdGUpKSB7XG4gICAgZXJyKCdtdXN0IHByb3ZpZGUgYXMgbWFueSBicmVha3MgYXJyYXlzIGFzIG51bWJlciBvZiBkYXRhc2V0cyB3aGVuIHVzaW5nIGNvbXBhcmUgYW5kIGJpdmFyaWF0ZSBtb2RlcycpO1xuICB9XG5cbiAgaWYgKHN1YmxheWVyQ29tYmluYXRpb25Nb2RlID09PSBTdWJsYXllckNvbWJpbmF0aW9uTW9kZS5UaW1lQ29tcGFyZSkge1xuICAgIGlmIChzdWJsYXllckNvdW50ICE9PSAyKSBlcnIoJ2RlbHRhIGNvbWJpbmF0aW9uTW9kZSByZXF1aXJlcyBzdWJsYXllciBjb3VudCA9PT0gMicpO1xuXG4gICAgaWYgKHN1YmxheWVyQnJlYWtzKSB7XG4gICAgICBpZiAoc3VibGF5ZXJCcmVha3MubGVuZ3RoICE9PSAxKSBlcnIoJ2RlbHRhIGNvbWJpbmF0aW9uTW9kZSByZXF1aXJlcyBleGFjdGx5IG9uZSBicmVha3MgYXJyYXkgdG8gZ2VuZXJhdGUgYSBkaXZlcmdpbmcgc2NhbGUnKTtcbiAgICB9XG4gIH1cblxuICBpZiAoc3VibGF5ZXJCcmVha3MgJiYgc3VibGF5ZXJCcmVha3MubGVuZ3RoICE9PSAxICYmIHN1YmxheWVyQ29tYmluYXRpb25Nb2RlID09PSBTdWJsYXllckNvbWJpbmF0aW9uTW9kZS5BZGQpIHtcbiAgICBlcnIoJ2FkZCBjb21iaW5hdGlvbk1vZGUgcmVxdWlyZXMgb25lIGFuZCBvbmx5IG9uZSBicmVha3MgYXJyYXknKTtcbiAgfVxuXG4gIGlmIChzdWJsYXllckNvbWJpbmF0aW9uTW9kZSA9PT0gU3VibGF5ZXJDb21iaW5hdGlvbk1vZGUuQml2YXJpYXRlKSB7XG4gICAgaWYgKHN1YmxheWVyQ291bnQgIT09IDIpIGVycignYml2YXJpYXRlIGNvbWJpbmF0aW9uTW9kZSByZXF1aXJlcyBleGFjdGx5IHR3byBkYXRhc2V0cycpO1xuXG4gICAgaWYgKHN1YmxheWVyQnJlYWtzKSB7XG4gICAgICBpZiAoc3VibGF5ZXJCcmVha3MubGVuZ3RoICE9PSAyKSBlcnIoJ2JpdmFyaWF0ZSBjb21iaW5hdGlvbk1vZGUgcmVxdWlyZXMgZXhhY3RseSB0d28gYnJlYWtzIGFycmF5Jyk7XG4gICAgICBpZiAoc3VibGF5ZXJCcmVha3NbMF0ubGVuZ3RoICE9PSBzdWJsYXllckJyZWFrc1sxXS5sZW5ndGgpIGVycignYml2YXJpYXRlIGJyZWFrcyBhcnJheXMgbXVzdCBoYXZlIHRoZSBzYW1lIGxlbmd0aCcpOyAvLyBUT0RPIFRoaXMgbWlnaHQgY2hhbmdlIGlmIHdlIHdhbnQgYml2YXJpYXRlIHdpdGggbW9yZSBvciBsZXNzIHRoYW4gMTYgY2xhc3Nlc1xuXG4gICAgICBpZiAoc3VibGF5ZXJCcmVha3NbMF0ubGVuZ3RoICE9PSA0IHx8IHN1YmxheWVyQnJlYWtzWzFdLmxlbmd0aCAhPT0gNCkgZXJyKCdlYWNoIGJpdmFyaWF0ZSBicmVha3MgYXJyYXkgcmVxdWlyZSBleGFjdGx5IDQgdmFsdWVzJyk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZmVhdHVyZXMgPSBbXTtcbiAgY29uc3QgZmVhdHVyZXNJbnRlcmFjdGl2ZSA9IFtdO1xuICBsZXQgYWdncmVnYXRpbmcgPSBBcnJheShzdWJsYXllckNvdW50KS5maWxsKFtdKTtcbiAgbGV0IGN1cnJlbnRBZ2dyZWdhdGVkVmFsdWVzID0gQXJyYXkoc3VibGF5ZXJDb3VudCkuZmlsbCgwKTtcbiAgbGV0IGN1cnJlbnRBZ2dyZWdhdGVkVmFsdWVzTGVuZ3RoID0gMDtcbiAgbGV0IGN1cnJlbnRGZWF0dXJlO1xuICBsZXQgY3VycmVudEZlYXR1cmVJbnRlcmFjdGl2ZTtcbiAgbGV0IGN1cnJlbnRGZWF0dXJlQ2VsbDtcbiAgbGV0IGN1cnJlbnRGZWF0dXJlTWluVGltZXN0YW1wO1xuICBsZXQgZmVhdHVyZUJ1ZmZlclZhbHVlc1BvcyA9IDA7XG4gIGxldCBoZWFkO1xuICBsZXQgdGFpbDtcbiAgbGV0IGRhdGFzZXRzSGlnaGVzdFJlYWxWYWx1ZSA9IE51bWJlci5ORUdBVElWRV9JTkZJTklUWTtcbiAgbGV0IGRhdGFzZXRzSGlnaGVzdFJlYWxWYWx1ZUluZGV4O1xuICBsZXQgcmVhbFZhbHVlc1N1bSA9IDA7XG4gIGxldCBsaXRlcmFsVmFsdWVzU3RyID0gJ1snO1xuICBsZXQgY3VtdWxhdGl2ZVZhbHVlc1BhZGRlZFN0cmluZ3MgPSBbXTtcbiAgY29uc3QgbnVtUm93cyA9IGludEFycmF5W0ZFQVRVUkVfUk9XX0lOREVYXTtcbiAgY29uc3QgbnVtQ29scyA9IGludEFycmF5W0ZFQVRVUkVfQ09MX0lOREVYXTtcbiAgY29uc3QgZmVhdHVyZUludEFycmF5cyA9IFtdO1xuICBsZXQgc3RhcnRGcmFtZSA9IDA7XG4gIGxldCBlbmRGcmFtZSA9IDA7XG4gIGxldCBzdGFydEluZGV4ID0gMDtcbiAgbGV0IGVuZEluZGV4ID0gMDtcbiAgbGV0IGluZGV4SW5DZWxsID0gMDsgLy8gV2UgbmVlZCB0byBwYWQgd2l0aCBuIHZhbHVlcyAobiA9PT0gZGVsdGEpIHRvIGdlbmVyYXRlIFwib3ZlcmZsb3dcIiBmcmFtZXNcbiAgLy8gaW4gdGhlIGNhc2Ugb2YgYSBzdW0sIGFkZCB6ZXJvZXMgd2hpY2ggd2lsbCBnZXQgYWRkZWQgdG8gdGhlIHJ1bm5pbmcgc3VubSB3aXRoIG5vIGVmZmVjdFxuICAvLyBpbiB0aGUgY2FzZSBvZiBhdmcsIHVzIE5hTiBhcyBhIGZsYWcgdG8gbm90IHRha2UgdGhlIHZhbHVlIGludG8gYWNjb3VudFxuXG4gIGNvbnN0IHBhZFZhbHVlID0gYWdncmVnYXRpb25PcGVyYXRpb24gPT09IEFnZ3JlZ2F0aW9uT3BlcmF0aW9uLkF2ZyA/IE5hTiA6IDA7XG5cbiAgZm9yIChsZXQgaSA9IEZFQVRVUkVfQ0VMTFNfU1RBUlRfSU5ERVg7IGkgPCBpbnRBcnJheS5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHZhbHVlID0gaW50QXJyYXlbaV07XG5cbiAgICBpZiAoaW5kZXhJbkNlbGwgPT09IENFTExfTlVNX0lOREVYKSB7XG4gICAgICBzdGFydEluZGV4ID0gaTtcbiAgICB9IGVsc2UgaWYgKGluZGV4SW5DZWxsID09PSBDRUxMX1NUQVJUX0lOREVYKSB7XG4gICAgICBzdGFydEZyYW1lID0gdmFsdWU7XG4gICAgfSBlbHNlIGlmIChpbmRleEluQ2VsbCA9PT0gQ0VMTF9FTkRfSU5ERVgpIHtcbiAgICAgIGVuZEZyYW1lID0gdmFsdWU7XG4gICAgICBlbmRJbmRleCA9IHN0YXJ0SW5kZXggKyBDRUxMX1ZBTFVFU19TVEFSVF9JTkRFWCArIChlbmRGcmFtZSAtIHN0YXJ0RnJhbWUgKyAxKSAqIHN1YmxheWVyQ291bnQ7XG4gICAgfVxuXG4gICAgaW5kZXhJbkNlbGwrKztcblxuICAgIGlmIChpID09PSBlbmRJbmRleCAtIDEpIHtcbiAgICAgIGluZGV4SW5DZWxsID0gMDtcbiAgICAgIGNvbnN0IG9yaWdpbmFsID0gaW50QXJyYXkuc2xpY2Uoc3RhcnRJbmRleCwgZW5kSW5kZXgpO1xuICAgICAgY29uc3QgcGFkZGVkID0gbmV3IEFycmF5KGRlbHRhICogc3VibGF5ZXJDb3VudCkuZmlsbChwYWRWYWx1ZSk7IC8vIFRPRE8gQXJlIHdlIHN1cmUgd2Ugd2FudCB0byB1c2UgRkVBVFVSRV9DRUxMU19TVEFSVF9JTkRFWCwgbm90IENFTExfU1RBUlRfSU5ERVg/P1xuXG4gICAgICBvcmlnaW5hbFtGRUFUVVJFX0NFTExTX1NUQVJUX0lOREVYXSA9IGVuZEZyYW1lICsgZGVsdGE7XG4gICAgICBjb25zdCBtZXJnZWQgPSBvcmlnaW5hbC5jb25jYXQocGFkZGVkKTtcbiAgICAgIGZlYXR1cmVJbnRBcnJheXMucHVzaChtZXJnZWQpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChzaW5nbGVGcmFtZSkge1xuICAgIGZvciAobGV0IGkgPSAyOyBpIDwgaW50QXJyYXkubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IHZhbHVlID0gaW50QXJyYXlbaV07XG5cbiAgICAgIGlmIChpICUgMiA9PT0gMCkge1xuICAgICAgICBjdXJyZW50RmVhdHVyZUNlbGwgPSB2YWx1ZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IHVuaXF1ZUlkID0gZ2VuZXJhdGVVbmlxdWVJZCh4LCB5LCBjdXJyZW50RmVhdHVyZUNlbGwpO1xuICAgICAgICBjb25zdCBmZWF0dXJlUGFyYW1zID0ge1xuICAgICAgICAgIGdlb21UeXBlLFxuICAgICAgICAgIHRpbGVCQm94LFxuICAgICAgICAgIGNlbGw6IGN1cnJlbnRGZWF0dXJlQ2VsbCxcbiAgICAgICAgICBudW1Db2xzLFxuICAgICAgICAgIG51bVJvd3MsXG4gICAgICAgICAgaWQ6IHVuaXF1ZUlkXG4gICAgICAgIH07XG4gICAgICAgIGN1cnJlbnRGZWF0dXJlID0gZ2V0RmVhdHVyZShmZWF0dXJlUGFyYW1zKTtcbiAgICAgICAgY3VycmVudEZlYXR1cmUucHJvcGVydGllcy52YWx1ZSA9IHZhbHVlIC8gVkFMVUVfTVVMVElQTElFUjtcbiAgICAgICAgZmVhdHVyZXMucHVzaChjdXJyZW50RmVhdHVyZSk7XG4gICAgICB9XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGZvciAobGV0IGYgPSAwOyBmIDwgZmVhdHVyZUludEFycmF5cy5sZW5ndGg7IGYrKykge1xuICAgICAgY29uc3QgZmVhdHVyZUludEFycmF5ID0gZmVhdHVyZUludEFycmF5c1tmXTtcbiAgICAgIGN1cnJlbnRGZWF0dXJlQ2VsbCA9IGZlYXR1cmVJbnRBcnJheVtDRUxMX05VTV9JTkRFWF07XG4gICAgICBjdXJyZW50RmVhdHVyZU1pblRpbWVzdGFtcCA9IGZlYXR1cmVJbnRBcnJheVtDRUxMX1NUQVJUX0lOREVYXTtcbiAgICAgIGhlYWQgPSBjdXJyZW50RmVhdHVyZU1pblRpbWVzdGFtcDtcbiAgICAgIGNvbnN0IHVuaXF1ZUlkID0gZ2VuZXJhdGVVbmlxdWVJZCh4LCB5LCBjdXJyZW50RmVhdHVyZUNlbGwpO1xuICAgICAgY29uc3QgZmVhdHVyZVBhcmFtcyA9IHtcbiAgICAgICAgZ2VvbVR5cGUsXG4gICAgICAgIHRpbGVCQm94LFxuICAgICAgICBjZWxsOiBjdXJyZW50RmVhdHVyZUNlbGwsXG4gICAgICAgIG51bUNvbHMsXG4gICAgICAgIG51bVJvd3MsXG4gICAgICAgIGlkOiB1bmlxdWVJZCxcbiAgICAgICAgYWRkTWV0YTogdHJ1ZVxuICAgICAgfTtcbiAgICAgIGN1cnJlbnRGZWF0dXJlID0gZ2V0RmVhdHVyZShmZWF0dXJlUGFyYW1zKTtcblxuICAgICAgaWYgKGludGVyYWN0aXZlKSB7XG4gICAgICAgIGN1cnJlbnRGZWF0dXJlSW50ZXJhY3RpdmUgPSBnZXRGZWF0dXJlKE9iamVjdC5hc3NpZ24oT2JqZWN0LmFzc2lnbih7fSwgZmVhdHVyZVBhcmFtcyksIHtcbiAgICAgICAgICBhZGRNZXRhOiB0cnVlXG4gICAgICAgIH0pKTtcbiAgICAgIH1cblxuICAgICAgZm9yIChsZXQgaSA9IENFTExfVkFMVUVTX1NUQVJUX0lOREVYOyBpIDwgZmVhdHVyZUludEFycmF5Lmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gZmVhdHVyZUludEFycmF5W2ldOyAvLyB3aGVuIHdlIGFyZSBsb29raW5nIGF0IHRzIDAgYW5kIGRlbHRhIGlzIDEwLCB3ZSBhcmUgaW4gZmFjdCBsb29raW5nIGF0IHRoZSBhZ2dyZWdhdGlvbiBvZiBkYXkgLTlcblxuICAgICAgICB0YWlsID0gaGVhZCAtIGRlbHRhICsgMTsgLy8gZ2V0cyBpbmRleCBvZiBkYXRhc2V0LCBrbm93aW5nIHRoYXQgYWZ0ZXIgaGVhZGVycyB2YWx1ZXMgZ29cbiAgICAgICAgLy8gZGF0YXNldDEsIGRhdGFzZXQyLCBkYXRhc2V0MSwgZGF0YXNldDIsIC4uLlxuXG4gICAgICAgIGNvbnN0IGRhdGFzZXRJbmRleCA9IGZlYXR1cmVCdWZmZXJWYWx1ZXNQb3MgJSBzdWJsYXllckNvdW50OyAvLyBjb2xsZWN0IHZhbHVlIGZvciB0aGlzIGRhdGFzZXRcblxuICAgICAgICBhZ2dyZWdhdGluZ1tkYXRhc2V0SW5kZXhdLnB1c2godmFsdWUpO1xuICAgICAgICBsZXQgdGFpbFZhbHVlID0gMDtcblxuICAgICAgICBpZiAodGFpbCA+IGN1cnJlbnRGZWF0dXJlTWluVGltZXN0YW1wKSB7XG4gICAgICAgICAgdGFpbFZhbHVlID0gYWdncmVnYXRpbmdbZGF0YXNldEluZGV4XS5zaGlmdCgpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgc2tpcEZyYW1lID0gaXNOYU4odmFsdWUpIHx8IHZhbHVlID09PSAwO1xuXG4gICAgICAgIGlmIChjdXJyZW50QWdncmVnYXRlZFZhbHVlc0xlbmd0aCA8IGRlbHRhICYmICFza2lwRnJhbWUpIHtcbiAgICAgICAgICBjdXJyZW50QWdncmVnYXRlZFZhbHVlc0xlbmd0aCsrO1xuICAgICAgICB9IC8vIGNvbGxlY3QgXCJ3b3JraW5nXCIgdmFsdWUsIGllIHZhbHVlIGF0IGhlYWQgYnkgc3Vic3RyYWN0aW5nIHRhaWwgdmFsdWVcblxuXG4gICAgICAgIGxldCByZWFsVmFsdWVBdEZyYW1lRm9yRGF0YXNldCA9IDA7XG4gICAgICAgIGxldCByZWFsVmFsdWVBdEZyYW1lRm9yRGF0YXNldFdvcmtpbmdWYWx1ZSA9IDA7XG5cbiAgICAgICAgaWYgKHN1YmxheWVyVmlzaWJpbGl0eVtkYXRhc2V0SW5kZXhdKSB7XG4gICAgICAgICAgaWYgKGFnZ3JlZ2F0aW9uT3BlcmF0aW9uID09PSBBZ2dyZWdhdGlvbk9wZXJhdGlvbi5BdmcpIHtcbiAgICAgICAgICAgIC8vIGlmIGlzTmFOLCB2YWx1ZSBpcyBqdXN0IGZvciBwYWRkaW5nIC0gc3RvcCBpbmNyZW1lbnRpbmcgcnVubmluZyBzdW0gKGp1c3QgcmVtb3ZlIHRhaWwpXG4gICAgICAgICAgICAvLyBhbmQgdGFrZSBpbnRvIGFjY291bnQgb25lIGxlc3MgZnJhbWUgdG8gY29tcHV0ZSB0aGUgYXZnXG4gICAgICAgICAgICByZWFsVmFsdWVBdEZyYW1lRm9yRGF0YXNldFdvcmtpbmdWYWx1ZSA9IHNraXBGcmFtZSA/IGN1cnJlbnRBZ2dyZWdhdGVkVmFsdWVzW2RhdGFzZXRJbmRleF0gLSB0YWlsVmFsdWUgOiBjdXJyZW50QWdncmVnYXRlZFZhbHVlc1tkYXRhc2V0SW5kZXhdICsgdmFsdWUgLSB0YWlsVmFsdWU7XG5cbiAgICAgICAgICAgIGlmIChza2lwRnJhbWUgJiYgY3VycmVudEFnZ3JlZ2F0ZWRWYWx1ZXNMZW5ndGggPiAwICYmIHRhaWxWYWx1ZSA+IDApIHtcbiAgICAgICAgICAgICAgY3VycmVudEFnZ3JlZ2F0ZWRWYWx1ZXNMZW5ndGgtLTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVhbFZhbHVlQXRGcmFtZUZvckRhdGFzZXQgPSBjdXJyZW50QWdncmVnYXRlZFZhbHVlc0xlbmd0aCA+IDAgPyByZWFsVmFsdWVBdEZyYW1lRm9yRGF0YXNldFdvcmtpbmdWYWx1ZSAvIGN1cnJlbnRBZ2dyZWdhdGVkVmFsdWVzTGVuZ3RoIDogcmVhbFZhbHVlQXRGcmFtZUZvckRhdGFzZXRXb3JraW5nVmFsdWU7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlYWxWYWx1ZUF0RnJhbWVGb3JEYXRhc2V0ID0gcmVhbFZhbHVlQXRGcmFtZUZvckRhdGFzZXRXb3JraW5nVmFsdWUgPSBjdXJyZW50QWdncmVnYXRlZFZhbHVlc1tkYXRhc2V0SW5kZXhdICsgdmFsdWUgLSB0YWlsVmFsdWU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY3VycmVudEFnZ3JlZ2F0ZWRWYWx1ZXNbZGF0YXNldEluZGV4XSA9IHJlYWxWYWx1ZUF0RnJhbWVGb3JEYXRhc2V0V29ya2luZ1ZhbHVlOyAvLyBDb21wdXRlIG1vZGUtc3BlY2lmaWMgdmFsdWVzXG5cbiAgICAgICAgaWYgKHN1YmxheWVyQ29tYmluYXRpb25Nb2RlID09PSBTdWJsYXllckNvbWJpbmF0aW9uTW9kZS5NYXgpIHtcbiAgICAgICAgICBpZiAocmVhbFZhbHVlQXRGcmFtZUZvckRhdGFzZXQgPiBkYXRhc2V0c0hpZ2hlc3RSZWFsVmFsdWUpIHtcbiAgICAgICAgICAgIGRhdGFzZXRzSGlnaGVzdFJlYWxWYWx1ZSA9IHJlYWxWYWx1ZUF0RnJhbWVGb3JEYXRhc2V0O1xuICAgICAgICAgICAgZGF0YXNldHNIaWdoZXN0UmVhbFZhbHVlSW5kZXggPSBkYXRhc2V0SW5kZXg7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHN1YmxheWVyQ29tYmluYXRpb25Nb2RlID09PSBTdWJsYXllckNvbWJpbmF0aW9uTW9kZS5BZGQgfHwgc3VibGF5ZXJDb21iaW5hdGlvbk1vZGUgPT09IFN1YmxheWVyQ29tYmluYXRpb25Nb2RlLkN1bXVsYXRpdmUpIHtcbiAgICAgICAgICByZWFsVmFsdWVzU3VtICs9IHJlYWxWYWx1ZUF0RnJhbWVGb3JEYXRhc2V0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHN1YmxheWVyQ29tYmluYXRpb25Nb2RlID09PSBTdWJsYXllckNvbWJpbmF0aW9uTW9kZS5DdW11bGF0aXZlKSB7XG4gICAgICAgICAgY29uc3QgY3VtdWxhdGl2ZVZhbHVlUGFkZGVkU3RyaW5nID0gTWF0aC5yb3VuZChyZWFsVmFsdWVzU3VtKS50b1N0cmluZygpLnBhZFN0YXJ0KDYsICcwJyk7XG4gICAgICAgICAgY3VtdWxhdGl2ZVZhbHVlc1BhZGRlZFN0cmluZ3MucHVzaChjdW11bGF0aXZlVmFsdWVQYWRkZWRTdHJpbmcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHN1YmxheWVyQ29tYmluYXRpb25Nb2RlID09PSBTdWJsYXllckNvbWJpbmF0aW9uTW9kZS5MaXRlcmFsKSB7XG4gICAgICAgICAgLy8gbGl0ZXJhbFZhbHVlc1N0ciArPSBNYXRoLmZsb29yKHJlYWxWYWx1ZUF0RnJhbWVGb3JEYXRhc2V0ICogMTAwKSAvIDEwMFxuICAgICAgICAgIC8vIEp1c3Qgcm91bmRpbmcgaXMgZmFzdGVyIC0gcmV2aXNlIGlmIGRlY2ltYWxzIGFyZSBuZWVkZWRcbiAgICAgICAgICAvLyBVc2UgY2VpbCB0byBhdm9pZCB2YWx1ZXMgYmVpbmcgJ211dGUnIHdoZW4gdmVyeSBjbG9zZSB0byB6ZXJvXG4gICAgICAgICAgLy8gVXBkYXRlOiB1c2UgLnJvdW5kIHRvIGF2b2lkIGRpc2NyZXBhbmNpZXMgYmV0d2VuIGludGVyYWN0aW9uIGFuZCB0b3RhbCBhbW1vdW50XG4gICAgICAgICAgbGl0ZXJhbFZhbHVlc1N0ciArPSBNYXRoLnJvdW5kKHJlYWxWYWx1ZUF0RnJhbWVGb3JEYXRhc2V0KTtcblxuICAgICAgICAgIGlmIChkYXRhc2V0SW5kZXggPCBzdWJsYXllckNvdW50IC0gMSkge1xuICAgICAgICAgICAgbGl0ZXJhbFZhbHVlc1N0ciArPSAnLCc7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcXVhbnRpemVkVGFpbCA9IHRhaWwgLSBxdWFudGl6ZU9mZnNldDtcblxuICAgICAgICBpZiAocXVhbnRpemVkVGFpbCA+PSAwICYmIGRhdGFzZXRJbmRleCA9PT0gc3VibGF5ZXJDb3VudCAtIDEpIHtcbiAgICAgICAgICBsZXQgZmluYWxWYWx1ZTtcblxuICAgICAgICAgIGlmIChzdWJsYXllckNvbWJpbmF0aW9uTW9kZSA9PT0gU3VibGF5ZXJDb21iaW5hdGlvbk1vZGUuTGl0ZXJhbCkge1xuICAgICAgICAgICAgbGl0ZXJhbFZhbHVlc1N0ciArPSAnXSc7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHN1YmxheWVyQ29tYmluYXRpb25Nb2RlID09PSBTdWJsYXllckNvbWJpbmF0aW9uTW9kZS5Ob25lKSB7XG4gICAgICAgICAgICBmaW5hbFZhbHVlID0gZ2V0VmFsdWUocmVhbFZhbHVlQXRGcmFtZUZvckRhdGFzZXQsIHN1YmxheWVyQnJlYWtzKTtcbiAgICAgICAgICB9IGVsc2UgaWYgKHN1YmxheWVyQ29tYmluYXRpb25Nb2RlID09PSBTdWJsYXllckNvbWJpbmF0aW9uTW9kZS5NYXgpIHtcbiAgICAgICAgICAgIGZpbmFsVmFsdWUgPSBnZXRDb21wYXJlVmFsdWUoZGF0YXNldHNIaWdoZXN0UmVhbFZhbHVlLCBkYXRhc2V0c0hpZ2hlc3RSZWFsVmFsdWVJbmRleCwgc3VibGF5ZXJCcmVha3MpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoc3VibGF5ZXJDb21iaW5hdGlvbk1vZGUgPT09IFN1YmxheWVyQ29tYmluYXRpb25Nb2RlLkFkZCkge1xuICAgICAgICAgICAgZmluYWxWYWx1ZSA9IGdldFZhbHVlKHJlYWxWYWx1ZXNTdW0sIHN1YmxheWVyQnJlYWtzKTtcbiAgICAgICAgICB9IGVsc2UgaWYgKHN1YmxheWVyQ29tYmluYXRpb25Nb2RlID09PSBTdWJsYXllckNvbWJpbmF0aW9uTW9kZS5CaXZhcmlhdGUpIHtcbiAgICAgICAgICAgIGZpbmFsVmFsdWUgPSBnZXRCaXZhcmlhdGVWYWx1ZShjdXJyZW50QWdncmVnYXRlZFZhbHVlcywgc3VibGF5ZXJCcmVha3MpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoc3VibGF5ZXJDb21iaW5hdGlvbk1vZGUgPT09IFN1YmxheWVyQ29tYmluYXRpb25Nb2RlLlRpbWVDb21wYXJlKSB7XG4gICAgICAgICAgICBmaW5hbFZhbHVlID0gZ2V0VGltZUNvbXBhcmVWYWx1ZShjdXJyZW50QWdncmVnYXRlZFZhbHVlcywgc3VibGF5ZXJCcmVha3MpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoc3VibGF5ZXJDb21iaW5hdGlvbk1vZGUgPT09IFN1YmxheWVyQ29tYmluYXRpb25Nb2RlLkxpdGVyYWwpIHtcbiAgICAgICAgICAgIGZpbmFsVmFsdWUgPSBsaXRlcmFsVmFsdWVzU3RyO1xuICAgICAgICAgIH0gZWxzZSBpZiAoc3VibGF5ZXJDb21iaW5hdGlvbk1vZGUgPT09IFN1YmxheWVyQ29tYmluYXRpb25Nb2RlLkN1bXVsYXRpdmUpIHtcbiAgICAgICAgICAgIGZpbmFsVmFsdWUgPSBnZXRDdW11bGF0aXZlVmFsdWUocmVhbFZhbHVlc1N1bSwgY3VtdWxhdGl2ZVZhbHVlc1BhZGRlZFN0cmluZ3MpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHdyaXRlVmFsdWVUb0ZlYXR1cmUocXVhbnRpemVkVGFpbCwgZmluYWxWYWx1ZSwgY3VycmVudEZlYXR1cmUpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGRhdGFzZXRJbmRleCA9PT0gc3VibGF5ZXJDb3VudCAtIDEpIHtcbiAgICAgICAgICAvLyBXaGVuIGFsbCBkYXRhc2V0IHZhbHVlcyBoYXZlIGJlZW4gY29sbGVjdGVkIGZvciB0aGlzIGZyYW1lLCB3ZSBjYW4gbW92ZSB0byBuZXh0IGZyYW1lXG4gICAgICAgICAgaGVhZCsrOyAvLyBSZXNldCBtb2RlLXNwZWNpZmljIHZhbHVlcyB3aGVuIGxhc3QgZGF0YXNldFxuXG4gICAgICAgICAgZGF0YXNldHNIaWdoZXN0UmVhbFZhbHVlID0gTnVtYmVyLk5FR0FUSVZFX0lORklOSVRZO1xuICAgICAgICAgIHJlYWxWYWx1ZXNTdW0gPSAwO1xuICAgICAgICAgIGN1bXVsYXRpdmVWYWx1ZXNQYWRkZWRTdHJpbmdzID0gW107XG4gICAgICAgICAgbGl0ZXJhbFZhbHVlc1N0ciA9ICdbJztcbiAgICAgICAgfVxuXG4gICAgICAgIGZlYXR1cmVCdWZmZXJWYWx1ZXNQb3MrKztcbiAgICAgIH1cblxuICAgICAgZmVhdHVyZXMucHVzaChjdXJyZW50RmVhdHVyZSk7XG5cbiAgICAgIGlmIChpbnRlcmFjdGl2ZSkge1xuICAgICAgICBjdXJyZW50RmVhdHVyZUludGVyYWN0aXZlLnByb3BlcnRpZXMucmF3VmFsdWVzID0gZmVhdHVyZUludEFycmF5O1xuICAgICAgICBmZWF0dXJlc0ludGVyYWN0aXZlLnB1c2goY3VycmVudEZlYXR1cmVJbnRlcmFjdGl2ZSk7XG4gICAgICB9XG5cbiAgICAgIGZlYXR1cmVCdWZmZXJWYWx1ZXNQb3MgPSAwO1xuICAgICAgZGF0YXNldHNIaWdoZXN0UmVhbFZhbHVlID0gTnVtYmVyLk5FR0FUSVZFX0lORklOSVRZO1xuICAgICAgcmVhbFZhbHVlc1N1bSA9IDA7XG4gICAgICBjdW11bGF0aXZlVmFsdWVzUGFkZGVkU3RyaW5ncyA9IFtdO1xuICAgICAgYWdncmVnYXRpbmcgPSBBcnJheShzdWJsYXllckNvdW50KS5maWxsKFtdKTtcbiAgICAgIGN1cnJlbnRBZ2dyZWdhdGVkVmFsdWVzID0gQXJyYXkoc3VibGF5ZXJDb3VudCkuZmlsbCgwKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGdlb0pTT05zID0ge1xuICAgIG1haW46IHtcbiAgICAgIHR5cGU6ICdGZWF0dXJlQ29sbGVjdGlvbicsXG4gICAgICBmZWF0dXJlc1xuICAgIH1cbiAgfTtcblxuICBpZiAoaW50ZXJhY3RpdmUpIHtcbiAgICBnZW9KU09Ocy5pbnRlcmFjdGl2ZSA9IHtcbiAgICAgIHR5cGU6ICdGZWF0dXJlQ29sbGVjdGlvbicsXG4gICAgICBmZWF0dXJlczogZmVhdHVyZXNJbnRlcmFjdGl2ZVxuICAgIH07XG4gIH1cblxuICByZXR1cm4gZ2VvSlNPTnM7XG59XG5cbmNvbnN0IGdldFRpbWVTZXJpZXMgPSAoZmVhdHVyZXMsIG51bVN1YmxheWVycywgcXVhbnRpemVPZmZzZXQgPSAwLCBhZ2dyZWdhdGlvbk9wZXJhdGlvbiA9IEFnZ3JlZ2F0aW9uT3BlcmF0aW9uLlN1bSkgPT4ge1xuICB2YXIgX2E7XG5cbiAgbGV0IG1pbkZyYW1lID0gTnVtYmVyLlBPU0lUSVZFX0lORklOSVRZO1xuICBsZXQgbWF4RnJhbWUgPSBOdW1iZXIuTkVHQVRJVkVfSU5GSU5JVFk7XG5cbiAgaWYgKCFmZWF0dXJlcyB8fCAhZmVhdHVyZXMubGVuZ3RoKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHZhbHVlczogW10sXG4gICAgICBtaW5GcmFtZSxcbiAgICAgIG1heEZyYW1lXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHZhbHVlc0J5RnJhbWUgPSBbXTtcbiAgZmVhdHVyZXMuZm9yRWFjaChmZWF0dXJlID0+IHtcbiAgICBjb25zdCByYXdWYWx1ZXMgPSBmZWF0dXJlLnByb3BlcnRpZXMucmF3VmFsdWVzO1xuICAgIGNvbnN0IHtcbiAgICAgIHZhbHVlcyxcbiAgICAgIG1pbkNlbGxPZmZzZXRcbiAgICB9ID0gZ2V0Q2VsbFZhbHVlcyhyYXdWYWx1ZXMpO1xuICAgIGlmIChtaW5DZWxsT2Zmc2V0IDwgbWluRnJhbWUpIG1pbkZyYW1lID0gbWluQ2VsbE9mZnNldDtcbiAgICBsZXQgY3VycmVudEZyYW1lSW5kZXggPSBtaW5DZWxsT2Zmc2V0O1xuICAgIGxldCBvZmZzZXRlZEN1cnJlbnRGcmFtZUluZGV4ID0gbWluQ2VsbE9mZnNldCAtIHF1YW50aXplT2Zmc2V0O1xuXG4gICAgZm9yIChsZXQgaSA9IENFTExfVkFMVUVTX1NUQVJUX0lOREVYOyBpIDwgdmFsdWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBzdWJsYXllckluZGV4ID0gKGkgLSBDRUxMX1ZBTFVFU19TVEFSVF9JTkRFWCkgJSBudW1TdWJsYXllcnM7XG4gICAgICBjb25zdCByYXdWYWx1ZSA9IHZhbHVlc1tpXTtcblxuICAgICAgaWYgKHJhd1ZhbHVlICE9PSBudWxsICYmICFpc05hTihyYXdWYWx1ZSkpIHtcbiAgICAgICAgaWYgKGN1cnJlbnRGcmFtZUluZGV4ID4gbWF4RnJhbWUpIG1heEZyYW1lID0gY3VycmVudEZyYW1lSW5kZXg7XG5cbiAgICAgICAgaWYgKCF2YWx1ZXNCeUZyYW1lW29mZnNldGVkQ3VycmVudEZyYW1lSW5kZXhdKSB7XG4gICAgICAgICAgdmFsdWVzQnlGcmFtZVtvZmZzZXRlZEN1cnJlbnRGcmFtZUluZGV4XSA9IHtcbiAgICAgICAgICAgIHN1YmxheWVyc1ZhbHVlczogbmV3IEFycmF5KG51bVN1YmxheWVycykuZmlsbCgwKSxcbiAgICAgICAgICAgIG51bVZhbHVlczogMFxuICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICB2YWx1ZXNCeUZyYW1lW29mZnNldGVkQ3VycmVudEZyYW1lSW5kZXhdLnN1YmxheWVyc1ZhbHVlc1tzdWJsYXllckluZGV4XSArPSByYXdWYWx1ZTtcblxuICAgICAgICBpZiAoc3VibGF5ZXJJbmRleCA9PT0gbnVtU3VibGF5ZXJzIC0gMSkge1xuICAgICAgICAgIC8vIGFzc3VtaW5nIHRoYXQgaWYgbGFzdCBzdWJsYXllciB2YWx1ZSAhaXNOYU4sIG90aGVyIHN1YmxheWVyIHZhbHVlcyB0b29cbiAgICAgICAgICB2YWx1ZXNCeUZyYW1lW29mZnNldGVkQ3VycmVudEZyYW1lSW5kZXhdLm51bVZhbHVlcysrO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChzdWJsYXllckluZGV4ID09PSBudW1TdWJsYXllcnMgLSAxKSB7XG4gICAgICAgIG9mZnNldGVkQ3VycmVudEZyYW1lSW5kZXgrKztcbiAgICAgICAgY3VycmVudEZyYW1lSW5kZXgrKztcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICBjb25zdCBudW1WYWx1ZXMgPSBtYXhGcmFtZSAtIG1pbkZyYW1lO1xuICBjb25zdCBmaW5hbFZhbHVlcyA9IG5ldyBBcnJheShudW1WYWx1ZXMpO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDw9IG51bVZhbHVlczsgaSsrKSB7XG4gICAgY29uc3QgZnJhbWUgPSBtaW5GcmFtZSArIGk7XG4gICAgY29uc3QgZnJhbWVWYWx1ZXMgPSAoX2EgPSB2YWx1ZXNCeUZyYW1lW2ZyYW1lIC0gcXVhbnRpemVPZmZzZXRdKSAhPT0gbnVsbCAmJiBfYSAhPT0gdm9pZCAwID8gX2EgOiB7XG4gICAgICBzdWJsYXllcnNWYWx1ZXM6IG5ldyBBcnJheShudW1TdWJsYXllcnMpLmZpbGwoMCksXG4gICAgICBudW1WYWx1ZXM6IDBcbiAgICB9O1xuICAgIGxldCBzdWJsYXllcnNWYWx1ZXM7XG5cbiAgICBpZiAoZnJhbWVWYWx1ZXMpIHtcbiAgICAgIHN1YmxheWVyc1ZhbHVlcyA9IGZyYW1lVmFsdWVzLnN1YmxheWVyc1ZhbHVlcztcblxuICAgICAgaWYgKGFnZ3JlZ2F0aW9uT3BlcmF0aW9uID09PSBBZ2dyZWdhdGlvbk9wZXJhdGlvbi5BdmcpIHtcbiAgICAgICAgc3VibGF5ZXJzVmFsdWVzID0gc3VibGF5ZXJzVmFsdWVzLm1hcChzdWJsYXllclZhbHVlID0+IHN1YmxheWVyVmFsdWUgLyBmcmFtZVZhbHVlcy5udW1WYWx1ZXMpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZpbmFsVmFsdWVzW2ldID0gT2JqZWN0LmFzc2lnbih7XG4gICAgICBmcmFtZVxuICAgIH0sIHN1YmxheWVyc1ZhbHVlcyk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHZhbHVlczogZmluYWxWYWx1ZXMsXG4gICAgbWluRnJhbWUsXG4gICAgbWF4RnJhbWVcbiAgfTtcbn07XG5cbmV4cG9ydCB7IEFnZ3JlZ2F0aW9uT3BlcmF0aW9uLCBDRUxMX0VORF9JTkRFWCwgQ0VMTF9OVU1fSU5ERVgsIENFTExfU1RBUlRfSU5ERVgsIENFTExfVkFMVUVTX1NUQVJUX0lOREVYLCBGRUFUVVJFX0NFTExTX1NUQVJUX0lOREVYLCBGRUFUVVJFX0NPTF9JTkRFWCwgRkVBVFVSRV9ST1dfSU5ERVgsIEdlb21UeXBlLCBTdWJsYXllckNvbWJpbmF0aW9uTW9kZSwgVkFMVUVfTVVMVElQTElFUiwgYWdncmVnYXRlLCBhZ2dyZWdhdGVDZWxsLCBnZW5lcmF0ZVVuaXF1ZUlkLCBnZXRDZWxsQXJyYXlJbmRleCwgZ2V0Q2VsbFZhbHVlcywgZ2V0UmVhbFZhbHVlLCBnZXRSZWFsVmFsdWVzLCBnZXRUaW1lU2VyaWVzIH07XG4iLCIndXNlIHN0cmljdCc7XG5cbnZhciBkMnIgPSBNYXRoLlBJIC8gMTgwLFxuICAgIHIyZCA9IDE4MCAvIE1hdGguUEk7XG5cbi8qKlxuICogR2V0IHRoZSBiYm94IG9mIGEgdGlsZVxuICpcbiAqIEBuYW1lIHRpbGVUb0JCT1hcbiAqIEBwYXJhbSB7QXJyYXk8bnVtYmVyPn0gdGlsZVxuICogQHJldHVybnMge0FycmF5PG51bWJlcj59IGJib3hcbiAqIEBleGFtcGxlXG4gKiB2YXIgYmJveCA9IHRpbGVUb0JCT1goWzUsIDEwLCAxMF0pXG4gKiAvLz1iYm94XG4gKi9cbmZ1bmN0aW9uIHRpbGVUb0JCT1godGlsZSkge1xuICAgIHZhciBlID0gdGlsZTJsb24odGlsZVswXSArIDEsIHRpbGVbMl0pO1xuICAgIHZhciB3ID0gdGlsZTJsb24odGlsZVswXSwgdGlsZVsyXSk7XG4gICAgdmFyIHMgPSB0aWxlMmxhdCh0aWxlWzFdICsgMSwgdGlsZVsyXSk7XG4gICAgdmFyIG4gPSB0aWxlMmxhdCh0aWxlWzFdLCB0aWxlWzJdKTtcbiAgICByZXR1cm4gW3csIHMsIGUsIG5dO1xufVxuXG4vKipcbiAqIEdldCBhIGdlb2pzb24gcmVwcmVzZW50YXRpb24gb2YgYSB0aWxlXG4gKlxuICogQG5hbWUgdGlsZVRvR2VvSlNPTlxuICogQHBhcmFtIHtBcnJheTxudW1iZXI+fSB0aWxlXG4gKiBAcmV0dXJucyB7RmVhdHVyZTxQb2x5Z29uPn1cbiAqIEBleGFtcGxlXG4gKiB2YXIgcG9seSA9IHRpbGVUb0dlb0pTT04oWzUsIDEwLCAxMF0pXG4gKiAvLz1wb2x5XG4gKi9cbmZ1bmN0aW9uIHRpbGVUb0dlb0pTT04odGlsZSkge1xuICAgIHZhciBiYm94ID0gdGlsZVRvQkJPWCh0aWxlKTtcbiAgICB2YXIgcG9seSA9IHtcbiAgICAgICAgdHlwZTogJ1BvbHlnb24nLFxuICAgICAgICBjb29yZGluYXRlczogW1tcbiAgICAgICAgICAgIFtiYm94WzBdLCBiYm94WzNdXSxcbiAgICAgICAgICAgIFtiYm94WzBdLCBiYm94WzFdXSxcbiAgICAgICAgICAgIFtiYm94WzJdLCBiYm94WzFdXSxcbiAgICAgICAgICAgIFtiYm94WzJdLCBiYm94WzNdXSxcbiAgICAgICAgICAgIFtiYm94WzBdLCBiYm94WzNdXVxuICAgICAgICBdXVxuICAgIH07XG4gICAgcmV0dXJuIHBvbHk7XG59XG5cbmZ1bmN0aW9uIHRpbGUybG9uKHgsIHopIHtcbiAgICByZXR1cm4geCAvIE1hdGgucG93KDIsIHopICogMzYwIC0gMTgwO1xufVxuXG5mdW5jdGlvbiB0aWxlMmxhdCh5LCB6KSB7XG4gICAgdmFyIG4gPSBNYXRoLlBJIC0gMiAqIE1hdGguUEkgKiB5IC8gTWF0aC5wb3coMiwgeik7XG4gICAgcmV0dXJuIHIyZCAqIE1hdGguYXRhbigwLjUgKiAoTWF0aC5leHAobikgLSBNYXRoLmV4cCgtbikpKTtcbn1cblxuLyoqXG4gKiBHZXQgdGhlIHRpbGUgZm9yIGEgcG9pbnQgYXQgYSBzcGVjaWZpZWQgem9vbSBsZXZlbFxuICpcbiAqIEBuYW1lIHBvaW50VG9UaWxlXG4gKiBAcGFyYW0ge251bWJlcn0gbG9uXG4gKiBAcGFyYW0ge251bWJlcn0gbGF0XG4gKiBAcGFyYW0ge251bWJlcn0gelxuICogQHJldHVybnMge0FycmF5PG51bWJlcj59IHRpbGVcbiAqIEBleGFtcGxlXG4gKiB2YXIgdGlsZSA9IHBvaW50VG9UaWxlKDEsIDEsIDIwKVxuICogLy89dGlsZVxuICovXG5mdW5jdGlvbiBwb2ludFRvVGlsZShsb24sIGxhdCwgeikge1xuICAgIHZhciB0aWxlID0gcG9pbnRUb1RpbGVGcmFjdGlvbihsb24sIGxhdCwgeik7XG4gICAgdGlsZVswXSA9IE1hdGguZmxvb3IodGlsZVswXSk7XG4gICAgdGlsZVsxXSA9IE1hdGguZmxvb3IodGlsZVsxXSk7XG4gICAgcmV0dXJuIHRpbGU7XG59XG5cbi8qKlxuICogR2V0IHRoZSA0IHRpbGVzIG9uZSB6b29tIGxldmVsIGhpZ2hlclxuICpcbiAqIEBuYW1lIGdldENoaWxkcmVuXG4gKiBAcGFyYW0ge0FycmF5PG51bWJlcj59IHRpbGVcbiAqIEByZXR1cm5zIHtBcnJheTxBcnJheTxudW1iZXI+Pn0gdGlsZXNcbiAqIEBleGFtcGxlXG4gKiB2YXIgdGlsZXMgPSBnZXRDaGlsZHJlbihbNSwgMTAsIDEwXSlcbiAqIC8vPXRpbGVzXG4gKi9cbmZ1bmN0aW9uIGdldENoaWxkcmVuKHRpbGUpIHtcbiAgICByZXR1cm4gW1xuICAgICAgICBbdGlsZVswXSAqIDIsIHRpbGVbMV0gKiAyLCB0aWxlWzJdICsgMV0sXG4gICAgICAgIFt0aWxlWzBdICogMiArIDEsIHRpbGVbMV0gKiAyLCB0aWxlWzIgXSArIDFdLFxuICAgICAgICBbdGlsZVswXSAqIDIgKyAxLCB0aWxlWzFdICogMiArIDEsIHRpbGVbMl0gKyAxXSxcbiAgICAgICAgW3RpbGVbMF0gKiAyLCB0aWxlWzFdICogMiArIDEsIHRpbGVbMl0gKyAxXVxuICAgIF07XG59XG5cbi8qKlxuICogR2V0IHRoZSB0aWxlIG9uZSB6b29tIGxldmVsIGxvd2VyXG4gKlxuICogQG5hbWUgZ2V0UGFyZW50XG4gKiBAcGFyYW0ge0FycmF5PG51bWJlcj59IHRpbGVcbiAqIEByZXR1cm5zIHtBcnJheTxudW1iZXI+fSB0aWxlXG4gKiBAZXhhbXBsZVxuICogdmFyIHRpbGUgPSBnZXRQYXJlbnQoWzUsIDEwLCAxMF0pXG4gKiAvLz10aWxlXG4gKi9cbmZ1bmN0aW9uIGdldFBhcmVudCh0aWxlKSB7XG4gICAgcmV0dXJuIFt0aWxlWzBdID4+IDEsIHRpbGVbMV0gPj4gMSwgdGlsZVsyXSAtIDFdO1xufVxuXG5mdW5jdGlvbiBnZXRTaWJsaW5ncyh0aWxlKSB7XG4gICAgcmV0dXJuIGdldENoaWxkcmVuKGdldFBhcmVudCh0aWxlKSk7XG59XG5cbi8qKlxuICogR2V0IHRoZSAzIHNpYmxpbmcgdGlsZXMgZm9yIGEgdGlsZVxuICpcbiAqIEBuYW1lIGdldFNpYmxpbmdzXG4gKiBAcGFyYW0ge0FycmF5PG51bWJlcj59IHRpbGVcbiAqIEByZXR1cm5zIHtBcnJheTxBcnJheTxudW1iZXI+Pn0gdGlsZXNcbiAqIEBleGFtcGxlXG4gKiB2YXIgdGlsZXMgPSBnZXRTaWJsaW5ncyhbNSwgMTAsIDEwXSlcbiAqIC8vPXRpbGVzXG4gKi9cbmZ1bmN0aW9uIGhhc1NpYmxpbmdzKHRpbGUsIHRpbGVzKSB7XG4gICAgdmFyIHNpYmxpbmdzID0gZ2V0U2libGluZ3ModGlsZSk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzaWJsaW5ncy5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAoIWhhc1RpbGUodGlsZXMsIHNpYmxpbmdzW2ldKSkgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiBDaGVjayB0byBzZWUgaWYgYW4gYXJyYXkgb2YgdGlsZXMgY29udGFpbnMgYSBwYXJ0aWN1bGFyIHRpbGVcbiAqXG4gKiBAbmFtZSBoYXNUaWxlXG4gKiBAcGFyYW0ge0FycmF5PEFycmF5PG51bWJlcj4+fSB0aWxlc1xuICogQHBhcmFtIHtBcnJheTxudW1iZXI+fSB0aWxlXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn1cbiAqIEBleGFtcGxlXG4gKiB2YXIgdGlsZXMgPSBbXG4gKiAgICAgWzAsIDAsIDVdLFxuICogICAgIFswLCAxLCA1XSxcbiAqICAgICBbMSwgMSwgNV0sXG4gKiAgICAgWzEsIDAsIDVdXG4gKiBdXG4gKiBoYXNUaWxlKHRpbGVzLCBbMCwgMCwgNV0pXG4gKiAvLz1ib29sZWFuXG4gKi9cbmZ1bmN0aW9uIGhhc1RpbGUodGlsZXMsIHRpbGUpIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRpbGVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmICh0aWxlc0VxdWFsKHRpbGVzW2ldLCB0aWxlKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbn1cblxuLyoqXG4gKiBDaGVjayB0byBzZWUgaWYgdHdvIHRpbGVzIGFyZSB0aGUgc2FtZVxuICpcbiAqIEBuYW1lIHRpbGVzRXF1YWxcbiAqIEBwYXJhbSB7QXJyYXk8bnVtYmVyPn0gdGlsZTFcbiAqIEBwYXJhbSB7QXJyYXk8bnVtYmVyPn0gdGlsZTJcbiAqIEByZXR1cm5zIHtib29sZWFufVxuICogQGV4YW1wbGVcbiAqIHRpbGVzRXF1YWwoWzAsIDEsIDVdLCBbMCwgMCwgNV0pXG4gKiAvLz1ib29sZWFuXG4gKi9cbmZ1bmN0aW9uIHRpbGVzRXF1YWwodGlsZTEsIHRpbGUyKSB7XG4gICAgcmV0dXJuIChcbiAgICAgICAgdGlsZTFbMF0gPT09IHRpbGUyWzBdICYmXG4gICAgICAgIHRpbGUxWzFdID09PSB0aWxlMlsxXSAmJlxuICAgICAgICB0aWxlMVsyXSA9PT0gdGlsZTJbMl1cbiAgICApO1xufVxuXG4vKipcbiAqIEdldCB0aGUgcXVhZGtleSBmb3IgYSB0aWxlXG4gKlxuICogQG5hbWUgdGlsZVRvUXVhZGtleVxuICogQHBhcmFtIHtBcnJheTxudW1iZXI+fSB0aWxlXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBxdWFka2V5XG4gKiBAZXhhbXBsZVxuICogdmFyIHF1YWRrZXkgPSB0aWxlVG9RdWFka2V5KFswLCAxLCA1XSlcbiAqIC8vPXF1YWRrZXlcbiAqL1xuZnVuY3Rpb24gdGlsZVRvUXVhZGtleSh0aWxlKSB7XG4gICAgdmFyIGluZGV4ID0gJyc7XG4gICAgZm9yICh2YXIgeiA9IHRpbGVbMl07IHogPiAwOyB6LS0pIHtcbiAgICAgICAgdmFyIGIgPSAwO1xuICAgICAgICB2YXIgbWFzayA9IDEgPDwgKHogLSAxKTtcbiAgICAgICAgaWYgKCh0aWxlWzBdICYgbWFzaykgIT09IDApIGIrKztcbiAgICAgICAgaWYgKCh0aWxlWzFdICYgbWFzaykgIT09IDApIGIgKz0gMjtcbiAgICAgICAgaW5kZXggKz0gYi50b1N0cmluZygpO1xuICAgIH1cbiAgICByZXR1cm4gaW5kZXg7XG59XG5cbi8qKlxuICogR2V0IHRoZSB0aWxlIGZvciBhIHF1YWRrZXlcbiAqXG4gKiBAbmFtZSBxdWFka2V5VG9UaWxlXG4gKiBAcGFyYW0ge3N0cmluZ30gcXVhZGtleVxuICogQHJldHVybnMge0FycmF5PG51bWJlcj59IHRpbGVcbiAqIEBleGFtcGxlXG4gKiB2YXIgdGlsZSA9IHF1YWRrZXlUb1RpbGUoJzAwMDAxMDMzJylcbiAqIC8vPXRpbGVcbiAqL1xuZnVuY3Rpb24gcXVhZGtleVRvVGlsZShxdWFka2V5KSB7XG4gICAgdmFyIHggPSAwO1xuICAgIHZhciB5ID0gMDtcbiAgICB2YXIgeiA9IHF1YWRrZXkubGVuZ3RoO1xuXG4gICAgZm9yICh2YXIgaSA9IHo7IGkgPiAwOyBpLS0pIHtcbiAgICAgICAgdmFyIG1hc2sgPSAxIDw8IChpIC0gMSk7XG4gICAgICAgIHZhciBxID0gK3F1YWRrZXlbeiAtIGldO1xuICAgICAgICBpZiAocSA9PT0gMSkgeCB8PSBtYXNrO1xuICAgICAgICBpZiAocSA9PT0gMikgeSB8PSBtYXNrO1xuICAgICAgICBpZiAocSA9PT0gMykge1xuICAgICAgICAgICAgeCB8PSBtYXNrO1xuICAgICAgICAgICAgeSB8PSBtYXNrO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiBbeCwgeSwgel07XG59XG5cbi8qKlxuICogR2V0IHRoZSBzbWFsbGVzdCB0aWxlIHRvIGNvdmVyIGEgYmJveFxuICpcbiAqIEBuYW1lIGJib3hUb1RpbGVcbiAqIEBwYXJhbSB7QXJyYXk8bnVtYmVyPn0gYmJveFxuICogQHJldHVybnMge0FycmF5PG51bWJlcj59IHRpbGVcbiAqIEBleGFtcGxlXG4gKiB2YXIgdGlsZSA9IGJib3hUb1RpbGUoWyAtMTc4LCA4NCwgLTE3NywgODUgXSlcbiAqIC8vPXRpbGVcbiAqL1xuZnVuY3Rpb24gYmJveFRvVGlsZShiYm94Q29vcmRzKSB7XG4gICAgdmFyIG1pbiA9IHBvaW50VG9UaWxlKGJib3hDb29yZHNbMF0sIGJib3hDb29yZHNbMV0sIDMyKTtcbiAgICB2YXIgbWF4ID0gcG9pbnRUb1RpbGUoYmJveENvb3Jkc1syXSwgYmJveENvb3Jkc1szXSwgMzIpO1xuICAgIHZhciBiYm94ID0gW21pblswXSwgbWluWzFdLCBtYXhbMF0sIG1heFsxXV07XG5cbiAgICB2YXIgeiA9IGdldEJib3hab29tKGJib3gpO1xuICAgIGlmICh6ID09PSAwKSByZXR1cm4gWzAsIDAsIDBdO1xuICAgIHZhciB4ID0gYmJveFswXSA+Pj4gKDMyIC0geik7XG4gICAgdmFyIHkgPSBiYm94WzFdID4+PiAoMzIgLSB6KTtcbiAgICByZXR1cm4gW3gsIHksIHpdO1xufVxuXG5mdW5jdGlvbiBnZXRCYm94Wm9vbShiYm94KSB7XG4gICAgdmFyIE1BWF9aT09NID0gMjg7XG4gICAgZm9yICh2YXIgeiA9IDA7IHogPCBNQVhfWk9PTTsgeisrKSB7XG4gICAgICAgIHZhciBtYXNrID0gMSA8PCAoMzIgLSAoeiArIDEpKTtcbiAgICAgICAgaWYgKCgoYmJveFswXSAmIG1hc2spICE9PSAoYmJveFsyXSAmIG1hc2spKSB8fFxuICAgICAgICAgICAgKChiYm94WzFdICYgbWFzaykgIT09IChiYm94WzNdICYgbWFzaykpKSB7XG4gICAgICAgICAgICByZXR1cm4gejtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBNQVhfWk9PTTtcbn1cblxuLyoqXG4gKiBHZXQgdGhlIHByZWNpc2UgZnJhY3Rpb25hbCB0aWxlIGxvY2F0aW9uIGZvciBhIHBvaW50IGF0IGEgem9vbSBsZXZlbFxuICpcbiAqIEBuYW1lIHBvaW50VG9UaWxlRnJhY3Rpb25cbiAqIEBwYXJhbSB7bnVtYmVyfSBsb25cbiAqIEBwYXJhbSB7bnVtYmVyfSBsYXRcbiAqIEBwYXJhbSB7bnVtYmVyfSB6XG4gKiBAcmV0dXJucyB7QXJyYXk8bnVtYmVyPn0gdGlsZSBmcmFjdGlvblxuICogdmFyIHRpbGUgPSBwb2ludFRvVGlsZUZyYWN0aW9uKDMwLjUsIDUwLjUsIDE1KVxuICogLy89dGlsZVxuICovXG5mdW5jdGlvbiBwb2ludFRvVGlsZUZyYWN0aW9uKGxvbiwgbGF0LCB6KSB7XG4gICAgdmFyIHNpbiA9IE1hdGguc2luKGxhdCAqIGQyciksXG4gICAgICAgIHoyID0gTWF0aC5wb3coMiwgeiksXG4gICAgICAgIHggPSB6MiAqIChsb24gLyAzNjAgKyAwLjUpLFxuICAgICAgICB5ID0gejIgKiAoMC41IC0gMC4yNSAqIE1hdGgubG9nKCgxICsgc2luKSAvICgxIC0gc2luKSkgLyBNYXRoLlBJKTtcblxuICAgIC8vIFdyYXAgVGlsZSBYXG4gICAgeCA9IHggJSB6MjtcbiAgICBpZiAoeCA8IDApIHggPSB4ICsgejI7XG4gICAgcmV0dXJuIFt4LCB5LCB6XTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gICAgdGlsZVRvR2VvSlNPTjogdGlsZVRvR2VvSlNPTixcbiAgICB0aWxlVG9CQk9YOiB0aWxlVG9CQk9YLFxuICAgIGdldENoaWxkcmVuOiBnZXRDaGlsZHJlbixcbiAgICBnZXRQYXJlbnQ6IGdldFBhcmVudCxcbiAgICBnZXRTaWJsaW5nczogZ2V0U2libGluZ3MsXG4gICAgaGFzVGlsZTogaGFzVGlsZSxcbiAgICBoYXNTaWJsaW5nczogaGFzU2libGluZ3MsXG4gICAgdGlsZXNFcXVhbDogdGlsZXNFcXVhbCxcbiAgICB0aWxlVG9RdWFka2V5OiB0aWxlVG9RdWFka2V5LFxuICAgIHF1YWRrZXlUb1RpbGU6IHF1YWRrZXlUb1RpbGUsXG4gICAgcG9pbnRUb1RpbGU6IHBvaW50VG9UaWxlLFxuICAgIGJib3hUb1RpbGU6IGJib3hUb1RpbGUsXG4gICAgcG9pbnRUb1RpbGVGcmFjdGlvbjogcG9pbnRUb1RpbGVGcmFjdGlvblxufTtcbiIsbnVsbCxudWxsLCJcbm1vZHVsZS5leHBvcnRzID0gcmV3aW5kO1xuXG5mdW5jdGlvbiByZXdpbmQoZ2osIG91dGVyKSB7XG4gICAgdmFyIHR5cGUgPSBnaiAmJiBnai50eXBlLCBpO1xuXG4gICAgaWYgKHR5cGUgPT09ICdGZWF0dXJlQ29sbGVjdGlvbicpIHtcbiAgICAgICAgZm9yIChpID0gMDsgaSA8IGdqLmZlYXR1cmVzLmxlbmd0aDsgaSsrKSByZXdpbmQoZ2ouZmVhdHVyZXNbaV0sIG91dGVyKTtcblxuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ0dlb21ldHJ5Q29sbGVjdGlvbicpIHtcbiAgICAgICAgZm9yIChpID0gMDsgaSA8IGdqLmdlb21ldHJpZXMubGVuZ3RoOyBpKyspIHJld2luZChnai5nZW9tZXRyaWVzW2ldLCBvdXRlcik7XG5cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdGZWF0dXJlJykge1xuICAgICAgICByZXdpbmQoZ2ouZ2VvbWV0cnksIG91dGVyKTtcblxuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgIHJld2luZFJpbmdzKGdqLmNvb3JkaW5hdGVzLCBvdXRlcik7XG5cbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdNdWx0aVBvbHlnb24nKSB7XG4gICAgICAgIGZvciAoaSA9IDA7IGkgPCBnai5jb29yZGluYXRlcy5sZW5ndGg7IGkrKykgcmV3aW5kUmluZ3MoZ2ouY29vcmRpbmF0ZXNbaV0sIG91dGVyKTtcbiAgICB9XG5cbiAgICByZXR1cm4gZ2o7XG59XG5cbmZ1bmN0aW9uIHJld2luZFJpbmdzKHJpbmdzLCBvdXRlcikge1xuICAgIGlmIChyaW5ncy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIHJld2luZFJpbmcocmluZ3NbMF0sIG91dGVyKTtcbiAgICBmb3IgKHZhciBpID0gMTsgaSA8IHJpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHJld2luZFJpbmcocmluZ3NbaV0sICFvdXRlcik7XG4gICAgfVxufVxuXG5mdW5jdGlvbiByZXdpbmRSaW5nKHJpbmcsIGRpcikge1xuICAgIHZhciBhcmVhID0gMCwgZXJyID0gMDtcbiAgICBmb3IgKHZhciBpID0gMCwgbGVuID0gcmluZy5sZW5ndGgsIGogPSBsZW4gLSAxOyBpIDwgbGVuOyBqID0gaSsrKSB7XG4gICAgICAgIHZhciBrID0gKHJpbmdbaV1bMF0gLSByaW5nW2pdWzBdKSAqIChyaW5nW2pdWzFdICsgcmluZ1tpXVsxXSk7XG4gICAgICAgIHZhciBtID0gYXJlYSArIGs7XG4gICAgICAgIGVyciArPSBNYXRoLmFicyhhcmVhKSA+PSBNYXRoLmFicyhrKSA/IGFyZWEgLSBtICsgayA6IGsgLSBtICsgYXJlYTtcbiAgICAgICAgYXJlYSA9IG07XG4gICAgfVxuICAgIGlmIChhcmVhICsgZXJyID49IDAgIT09ICEhZGlyKSByaW5nLnJldmVyc2UoKTtcbn1cbiIsIlxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gc29ydEtEKGlkcywgY29vcmRzLCBub2RlU2l6ZSwgbGVmdCwgcmlnaHQsIGRlcHRoKSB7XG4gICAgaWYgKHJpZ2h0IC0gbGVmdCA8PSBub2RlU2l6ZSkgcmV0dXJuO1xuXG4gICAgY29uc3QgbSA9IChsZWZ0ICsgcmlnaHQpID4+IDE7XG5cbiAgICBzZWxlY3QoaWRzLCBjb29yZHMsIG0sIGxlZnQsIHJpZ2h0LCBkZXB0aCAlIDIpO1xuXG4gICAgc29ydEtEKGlkcywgY29vcmRzLCBub2RlU2l6ZSwgbGVmdCwgbSAtIDEsIGRlcHRoICsgMSk7XG4gICAgc29ydEtEKGlkcywgY29vcmRzLCBub2RlU2l6ZSwgbSArIDEsIHJpZ2h0LCBkZXB0aCArIDEpO1xufVxuXG5mdW5jdGlvbiBzZWxlY3QoaWRzLCBjb29yZHMsIGssIGxlZnQsIHJpZ2h0LCBpbmMpIHtcblxuICAgIHdoaWxlIChyaWdodCA+IGxlZnQpIHtcbiAgICAgICAgaWYgKHJpZ2h0IC0gbGVmdCA+IDYwMCkge1xuICAgICAgICAgICAgY29uc3QgbiA9IHJpZ2h0IC0gbGVmdCArIDE7XG4gICAgICAgICAgICBjb25zdCBtID0gayAtIGxlZnQgKyAxO1xuICAgICAgICAgICAgY29uc3QgeiA9IE1hdGgubG9nKG4pO1xuICAgICAgICAgICAgY29uc3QgcyA9IDAuNSAqIE1hdGguZXhwKDIgKiB6IC8gMyk7XG4gICAgICAgICAgICBjb25zdCBzZCA9IDAuNSAqIE1hdGguc3FydCh6ICogcyAqIChuIC0gcykgLyBuKSAqIChtIC0gbiAvIDIgPCAwID8gLTEgOiAxKTtcbiAgICAgICAgICAgIGNvbnN0IG5ld0xlZnQgPSBNYXRoLm1heChsZWZ0LCBNYXRoLmZsb29yKGsgLSBtICogcyAvIG4gKyBzZCkpO1xuICAgICAgICAgICAgY29uc3QgbmV3UmlnaHQgPSBNYXRoLm1pbihyaWdodCwgTWF0aC5mbG9vcihrICsgKG4gLSBtKSAqIHMgLyBuICsgc2QpKTtcbiAgICAgICAgICAgIHNlbGVjdChpZHMsIGNvb3JkcywgaywgbmV3TGVmdCwgbmV3UmlnaHQsIGluYyk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB0ID0gY29vcmRzWzIgKiBrICsgaW5jXTtcbiAgICAgICAgbGV0IGkgPSBsZWZ0O1xuICAgICAgICBsZXQgaiA9IHJpZ2h0O1xuXG4gICAgICAgIHN3YXBJdGVtKGlkcywgY29vcmRzLCBsZWZ0LCBrKTtcbiAgICAgICAgaWYgKGNvb3Jkc1syICogcmlnaHQgKyBpbmNdID4gdCkgc3dhcEl0ZW0oaWRzLCBjb29yZHMsIGxlZnQsIHJpZ2h0KTtcblxuICAgICAgICB3aGlsZSAoaSA8IGopIHtcbiAgICAgICAgICAgIHN3YXBJdGVtKGlkcywgY29vcmRzLCBpLCBqKTtcbiAgICAgICAgICAgIGkrKztcbiAgICAgICAgICAgIGotLTtcbiAgICAgICAgICAgIHdoaWxlIChjb29yZHNbMiAqIGkgKyBpbmNdIDwgdCkgaSsrO1xuICAgICAgICAgICAgd2hpbGUgKGNvb3Jkc1syICogaiArIGluY10gPiB0KSBqLS07XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29vcmRzWzIgKiBsZWZ0ICsgaW5jXSA9PT0gdCkgc3dhcEl0ZW0oaWRzLCBjb29yZHMsIGxlZnQsIGopO1xuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIGorKztcbiAgICAgICAgICAgIHN3YXBJdGVtKGlkcywgY29vcmRzLCBqLCByaWdodCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaiA8PSBrKSBsZWZ0ID0gaiArIDE7XG4gICAgICAgIGlmIChrIDw9IGopIHJpZ2h0ID0gaiAtIDE7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBzd2FwSXRlbShpZHMsIGNvb3JkcywgaSwgaikge1xuICAgIHN3YXAoaWRzLCBpLCBqKTtcbiAgICBzd2FwKGNvb3JkcywgMiAqIGksIDIgKiBqKTtcbiAgICBzd2FwKGNvb3JkcywgMiAqIGkgKyAxLCAyICogaiArIDEpO1xufVxuXG5mdW5jdGlvbiBzd2FwKGFyciwgaSwgaikge1xuICAgIGNvbnN0IHRtcCA9IGFycltpXTtcbiAgICBhcnJbaV0gPSBhcnJbal07XG4gICAgYXJyW2pdID0gdG1wO1xufVxuIiwiXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiByYW5nZShpZHMsIGNvb3JkcywgbWluWCwgbWluWSwgbWF4WCwgbWF4WSwgbm9kZVNpemUpIHtcbiAgICBjb25zdCBzdGFjayA9IFswLCBpZHMubGVuZ3RoIC0gMSwgMF07XG4gICAgY29uc3QgcmVzdWx0ID0gW107XG4gICAgbGV0IHgsIHk7XG5cbiAgICB3aGlsZSAoc3RhY2subGVuZ3RoKSB7XG4gICAgICAgIGNvbnN0IGF4aXMgPSBzdGFjay5wb3AoKTtcbiAgICAgICAgY29uc3QgcmlnaHQgPSBzdGFjay5wb3AoKTtcbiAgICAgICAgY29uc3QgbGVmdCA9IHN0YWNrLnBvcCgpO1xuXG4gICAgICAgIGlmIChyaWdodCAtIGxlZnQgPD0gbm9kZVNpemUpIHtcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSBsZWZ0OyBpIDw9IHJpZ2h0OyBpKyspIHtcbiAgICAgICAgICAgICAgICB4ID0gY29vcmRzWzIgKiBpXTtcbiAgICAgICAgICAgICAgICB5ID0gY29vcmRzWzIgKiBpICsgMV07XG4gICAgICAgICAgICAgICAgaWYgKHggPj0gbWluWCAmJiB4IDw9IG1heFggJiYgeSA+PSBtaW5ZICYmIHkgPD0gbWF4WSkgcmVzdWx0LnB1c2goaWRzW2ldKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgbSA9IE1hdGguZmxvb3IoKGxlZnQgKyByaWdodCkgLyAyKTtcblxuICAgICAgICB4ID0gY29vcmRzWzIgKiBtXTtcbiAgICAgICAgeSA9IGNvb3Jkc1syICogbSArIDFdO1xuXG4gICAgICAgIGlmICh4ID49IG1pblggJiYgeCA8PSBtYXhYICYmIHkgPj0gbWluWSAmJiB5IDw9IG1heFkpIHJlc3VsdC5wdXNoKGlkc1ttXSk7XG5cbiAgICAgICAgY29uc3QgbmV4dEF4aXMgPSAoYXhpcyArIDEpICUgMjtcblxuICAgICAgICBpZiAoYXhpcyA9PT0gMCA/IG1pblggPD0geCA6IG1pblkgPD0geSkge1xuICAgICAgICAgICAgc3RhY2sucHVzaChsZWZ0KTtcbiAgICAgICAgICAgIHN0YWNrLnB1c2gobSAtIDEpO1xuICAgICAgICAgICAgc3RhY2sucHVzaChuZXh0QXhpcyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGF4aXMgPT09IDAgPyBtYXhYID49IHggOiBtYXhZID49IHkpIHtcbiAgICAgICAgICAgIHN0YWNrLnB1c2gobSArIDEpO1xuICAgICAgICAgICAgc3RhY2sucHVzaChyaWdodCk7XG4gICAgICAgICAgICBzdGFjay5wdXNoKG5leHRBeGlzKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG59XG4iLCJcbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIHdpdGhpbihpZHMsIGNvb3JkcywgcXgsIHF5LCByLCBub2RlU2l6ZSkge1xuICAgIGNvbnN0IHN0YWNrID0gWzAsIGlkcy5sZW5ndGggLSAxLCAwXTtcbiAgICBjb25zdCByZXN1bHQgPSBbXTtcbiAgICBjb25zdCByMiA9IHIgKiByO1xuXG4gICAgd2hpbGUgKHN0YWNrLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBheGlzID0gc3RhY2sucG9wKCk7XG4gICAgICAgIGNvbnN0IHJpZ2h0ID0gc3RhY2sucG9wKCk7XG4gICAgICAgIGNvbnN0IGxlZnQgPSBzdGFjay5wb3AoKTtcblxuICAgICAgICBpZiAocmlnaHQgLSBsZWZ0IDw9IG5vZGVTaXplKSB7XG4gICAgICAgICAgICBmb3IgKGxldCBpID0gbGVmdDsgaSA8PSByaWdodDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgaWYgKHNxRGlzdChjb29yZHNbMiAqIGldLCBjb29yZHNbMiAqIGkgKyAxXSwgcXgsIHF5KSA8PSByMikgcmVzdWx0LnB1c2goaWRzW2ldKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgbSA9IE1hdGguZmxvb3IoKGxlZnQgKyByaWdodCkgLyAyKTtcblxuICAgICAgICBjb25zdCB4ID0gY29vcmRzWzIgKiBtXTtcbiAgICAgICAgY29uc3QgeSA9IGNvb3Jkc1syICogbSArIDFdO1xuXG4gICAgICAgIGlmIChzcURpc3QoeCwgeSwgcXgsIHF5KSA8PSByMikgcmVzdWx0LnB1c2goaWRzW21dKTtcblxuICAgICAgICBjb25zdCBuZXh0QXhpcyA9IChheGlzICsgMSkgJSAyO1xuXG4gICAgICAgIGlmIChheGlzID09PSAwID8gcXggLSByIDw9IHggOiBxeSAtIHIgPD0geSkge1xuICAgICAgICAgICAgc3RhY2sucHVzaChsZWZ0KTtcbiAgICAgICAgICAgIHN0YWNrLnB1c2gobSAtIDEpO1xuICAgICAgICAgICAgc3RhY2sucHVzaChuZXh0QXhpcyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGF4aXMgPT09IDAgPyBxeCArIHIgPj0geCA6IHF5ICsgciA+PSB5KSB7XG4gICAgICAgICAgICBzdGFjay5wdXNoKG0gKyAxKTtcbiAgICAgICAgICAgIHN0YWNrLnB1c2gocmlnaHQpO1xuICAgICAgICAgICAgc3RhY2sucHVzaChuZXh0QXhpcyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiBzcURpc3QoYXgsIGF5LCBieCwgYnkpIHtcbiAgICBjb25zdCBkeCA9IGF4IC0gYng7XG4gICAgY29uc3QgZHkgPSBheSAtIGJ5O1xuICAgIHJldHVybiBkeCAqIGR4ICsgZHkgKiBkeTtcbn1cbiIsIlxuaW1wb3J0IHNvcnQgZnJvbSAnLi9zb3J0JztcbmltcG9ydCByYW5nZSBmcm9tICcuL3JhbmdlJztcbmltcG9ydCB3aXRoaW4gZnJvbSAnLi93aXRoaW4nO1xuXG5jb25zdCBkZWZhdWx0R2V0WCA9IHAgPT4gcFswXTtcbmNvbnN0IGRlZmF1bHRHZXRZID0gcCA9PiBwWzFdO1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBLREJ1c2gge1xuICAgIGNvbnN0cnVjdG9yKHBvaW50cywgZ2V0WCA9IGRlZmF1bHRHZXRYLCBnZXRZID0gZGVmYXVsdEdldFksIG5vZGVTaXplID0gNjQsIEFycmF5VHlwZSA9IEZsb2F0NjRBcnJheSkge1xuICAgICAgICB0aGlzLm5vZGVTaXplID0gbm9kZVNpemU7XG4gICAgICAgIHRoaXMucG9pbnRzID0gcG9pbnRzO1xuXG4gICAgICAgIGNvbnN0IEluZGV4QXJyYXlUeXBlID0gcG9pbnRzLmxlbmd0aCA8IDY1NTM2ID8gVWludDE2QXJyYXkgOiBVaW50MzJBcnJheTtcblxuICAgICAgICBjb25zdCBpZHMgPSB0aGlzLmlkcyA9IG5ldyBJbmRleEFycmF5VHlwZShwb2ludHMubGVuZ3RoKTtcbiAgICAgICAgY29uc3QgY29vcmRzID0gdGhpcy5jb29yZHMgPSBuZXcgQXJyYXlUeXBlKHBvaW50cy5sZW5ndGggKiAyKTtcblxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHBvaW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgaWRzW2ldID0gaTtcbiAgICAgICAgICAgIGNvb3Jkc1syICogaV0gPSBnZXRYKHBvaW50c1tpXSk7XG4gICAgICAgICAgICBjb29yZHNbMiAqIGkgKyAxXSA9IGdldFkocG9pbnRzW2ldKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNvcnQoaWRzLCBjb29yZHMsIG5vZGVTaXplLCAwLCBpZHMubGVuZ3RoIC0gMSwgMCk7XG4gICAgfVxuXG4gICAgcmFuZ2UobWluWCwgbWluWSwgbWF4WCwgbWF4WSkge1xuICAgICAgICByZXR1cm4gcmFuZ2UodGhpcy5pZHMsIHRoaXMuY29vcmRzLCBtaW5YLCBtaW5ZLCBtYXhYLCBtYXhZLCB0aGlzLm5vZGVTaXplKTtcbiAgICB9XG5cbiAgICB3aXRoaW4oeCwgeSwgcikge1xuICAgICAgICByZXR1cm4gd2l0aGluKHRoaXMuaWRzLCB0aGlzLmNvb3JkcywgeCwgeSwgciwgdGhpcy5ub2RlU2l6ZSk7XG4gICAgfVxufVxuIiwiXG5pbXBvcnQgS0RCdXNoIGZyb20gJ2tkYnVzaCc7XG5cbmNvbnN0IGRlZmF1bHRPcHRpb25zID0ge1xuICAgIG1pblpvb206IDAsICAgLy8gbWluIHpvb20gdG8gZ2VuZXJhdGUgY2x1c3RlcnMgb25cbiAgICBtYXhab29tOiAxNiwgIC8vIG1heCB6b29tIGxldmVsIHRvIGNsdXN0ZXIgdGhlIHBvaW50cyBvblxuICAgIG1pblBvaW50czogMiwgLy8gbWluaW11bSBwb2ludHMgdG8gZm9ybSBhIGNsdXN0ZXJcbiAgICByYWRpdXM6IDQwLCAgIC8vIGNsdXN0ZXIgcmFkaXVzIGluIHBpeGVsc1xuICAgIGV4dGVudDogNTEyLCAgLy8gdGlsZSBleHRlbnQgKHJhZGl1cyBpcyBjYWxjdWxhdGVkIHJlbGF0aXZlIHRvIGl0KVxuICAgIG5vZGVTaXplOiA2NCwgLy8gc2l6ZSBvZiB0aGUgS0QtdHJlZSBsZWFmIG5vZGUsIGFmZmVjdHMgcGVyZm9ybWFuY2VcbiAgICBsb2c6IGZhbHNlLCAgIC8vIHdoZXRoZXIgdG8gbG9nIHRpbWluZyBpbmZvXG5cbiAgICAvLyB3aGV0aGVyIHRvIGdlbmVyYXRlIG51bWVyaWMgaWRzIGZvciBpbnB1dCBmZWF0dXJlcyAoaW4gdmVjdG9yIHRpbGVzKVxuICAgIGdlbmVyYXRlSWQ6IGZhbHNlLFxuXG4gICAgLy8gYSByZWR1Y2UgZnVuY3Rpb24gZm9yIGNhbGN1bGF0aW5nIGN1c3RvbSBjbHVzdGVyIHByb3BlcnRpZXNcbiAgICByZWR1Y2U6IG51bGwsIC8vIChhY2N1bXVsYXRlZCwgcHJvcHMpID0+IHsgYWNjdW11bGF0ZWQuc3VtICs9IHByb3BzLnN1bTsgfVxuXG4gICAgLy8gcHJvcGVydGllcyB0byB1c2UgZm9yIGluZGl2aWR1YWwgcG9pbnRzIHdoZW4gcnVubmluZyB0aGUgcmVkdWNlclxuICAgIG1hcDogcHJvcHMgPT4gcHJvcHMgLy8gcHJvcHMgPT4gKHtzdW06IHByb3BzLm15X3ZhbHVlfSlcbn07XG5cbmNvbnN0IGZyb3VuZCA9IE1hdGguZnJvdW5kIHx8ICh0bXAgPT4gKCh4KSA9PiB7IHRtcFswXSA9ICt4OyByZXR1cm4gdG1wWzBdOyB9KSkobmV3IEZsb2F0MzJBcnJheSgxKSk7XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFN1cGVyY2x1c3RlciB7XG4gICAgY29uc3RydWN0b3Iob3B0aW9ucykge1xuICAgICAgICB0aGlzLm9wdGlvbnMgPSBleHRlbmQoT2JqZWN0LmNyZWF0ZShkZWZhdWx0T3B0aW9ucyksIG9wdGlvbnMpO1xuICAgICAgICB0aGlzLnRyZWVzID0gbmV3IEFycmF5KHRoaXMub3B0aW9ucy5tYXhab29tICsgMSk7XG4gICAgfVxuXG4gICAgbG9hZChwb2ludHMpIHtcbiAgICAgICAgY29uc3Qge2xvZywgbWluWm9vbSwgbWF4Wm9vbSwgbm9kZVNpemV9ID0gdGhpcy5vcHRpb25zO1xuXG4gICAgICAgIGlmIChsb2cpIGNvbnNvbGUudGltZSgndG90YWwgdGltZScpO1xuXG4gICAgICAgIGNvbnN0IHRpbWVySWQgPSBgcHJlcGFyZSAkeyAgcG9pbnRzLmxlbmd0aCAgfSBwb2ludHNgO1xuICAgICAgICBpZiAobG9nKSBjb25zb2xlLnRpbWUodGltZXJJZCk7XG5cbiAgICAgICAgdGhpcy5wb2ludHMgPSBwb2ludHM7XG5cbiAgICAgICAgLy8gZ2VuZXJhdGUgYSBjbHVzdGVyIG9iamVjdCBmb3IgZWFjaCBwb2ludCBhbmQgaW5kZXggaW5wdXQgcG9pbnRzIGludG8gYSBLRC10cmVlXG4gICAgICAgIGxldCBjbHVzdGVycyA9IFtdO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHBvaW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgaWYgKCFwb2ludHNbaV0uZ2VvbWV0cnkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY2x1c3RlcnMucHVzaChjcmVhdGVQb2ludENsdXN0ZXIocG9pbnRzW2ldLCBpKSk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy50cmVlc1ttYXhab29tICsgMV0gPSBuZXcgS0RCdXNoKGNsdXN0ZXJzLCBnZXRYLCBnZXRZLCBub2RlU2l6ZSwgRmxvYXQzMkFycmF5KTtcblxuICAgICAgICBpZiAobG9nKSBjb25zb2xlLnRpbWVFbmQodGltZXJJZCk7XG5cbiAgICAgICAgLy8gY2x1c3RlciBwb2ludHMgb24gbWF4IHpvb20sIHRoZW4gY2x1c3RlciB0aGUgcmVzdWx0cyBvbiBwcmV2aW91cyB6b29tLCBldGMuO1xuICAgICAgICAvLyByZXN1bHRzIGluIGEgY2x1c3RlciBoaWVyYXJjaHkgYWNyb3NzIHpvb20gbGV2ZWxzXG4gICAgICAgIGZvciAobGV0IHogPSBtYXhab29tOyB6ID49IG1pblpvb207IHotLSkge1xuICAgICAgICAgICAgY29uc3Qgbm93ID0gK0RhdGUubm93KCk7XG5cbiAgICAgICAgICAgIC8vIGNyZWF0ZSBhIG5ldyBzZXQgb2YgY2x1c3RlcnMgZm9yIHRoZSB6b29tIGFuZCBpbmRleCB0aGVtIHdpdGggYSBLRC10cmVlXG4gICAgICAgICAgICBjbHVzdGVycyA9IHRoaXMuX2NsdXN0ZXIoY2x1c3RlcnMsIHopO1xuICAgICAgICAgICAgdGhpcy50cmVlc1t6XSA9IG5ldyBLREJ1c2goY2x1c3RlcnMsIGdldFgsIGdldFksIG5vZGVTaXplLCBGbG9hdDMyQXJyYXkpO1xuXG4gICAgICAgICAgICBpZiAobG9nKSBjb25zb2xlLmxvZygneiVkOiAlZCBjbHVzdGVycyBpbiAlZG1zJywgeiwgY2x1c3RlcnMubGVuZ3RoLCArRGF0ZS5ub3coKSAtIG5vdyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobG9nKSBjb25zb2xlLnRpbWVFbmQoJ3RvdGFsIHRpbWUnKTtcblxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG5cbiAgICBnZXRDbHVzdGVycyhiYm94LCB6b29tKSB7XG4gICAgICAgIGxldCBtaW5MbmcgPSAoKGJib3hbMF0gKyAxODApICUgMzYwICsgMzYwKSAlIDM2MCAtIDE4MDtcbiAgICAgICAgY29uc3QgbWluTGF0ID0gTWF0aC5tYXgoLTkwLCBNYXRoLm1pbig5MCwgYmJveFsxXSkpO1xuICAgICAgICBsZXQgbWF4TG5nID0gYmJveFsyXSA9PT0gMTgwID8gMTgwIDogKChiYm94WzJdICsgMTgwKSAlIDM2MCArIDM2MCkgJSAzNjAgLSAxODA7XG4gICAgICAgIGNvbnN0IG1heExhdCA9IE1hdGgubWF4KC05MCwgTWF0aC5taW4oOTAsIGJib3hbM10pKTtcblxuICAgICAgICBpZiAoYmJveFsyXSAtIGJib3hbMF0gPj0gMzYwKSB7XG4gICAgICAgICAgICBtaW5MbmcgPSAtMTgwO1xuICAgICAgICAgICAgbWF4TG5nID0gMTgwO1xuICAgICAgICB9IGVsc2UgaWYgKG1pbkxuZyA+IG1heExuZykge1xuICAgICAgICAgICAgY29uc3QgZWFzdGVybkhlbSA9IHRoaXMuZ2V0Q2x1c3RlcnMoW21pbkxuZywgbWluTGF0LCAxODAsIG1heExhdF0sIHpvb20pO1xuICAgICAgICAgICAgY29uc3Qgd2VzdGVybkhlbSA9IHRoaXMuZ2V0Q2x1c3RlcnMoWy0xODAsIG1pbkxhdCwgbWF4TG5nLCBtYXhMYXRdLCB6b29tKTtcbiAgICAgICAgICAgIHJldHVybiBlYXN0ZXJuSGVtLmNvbmNhdCh3ZXN0ZXJuSGVtKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRyZWUgPSB0aGlzLnRyZWVzW3RoaXMuX2xpbWl0Wm9vbSh6b29tKV07XG4gICAgICAgIGNvbnN0IGlkcyA9IHRyZWUucmFuZ2UobG5nWChtaW5MbmcpLCBsYXRZKG1heExhdCksIGxuZ1gobWF4TG5nKSwgbGF0WShtaW5MYXQpKTtcbiAgICAgICAgY29uc3QgY2x1c3RlcnMgPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBpZCBvZiBpZHMpIHtcbiAgICAgICAgICAgIGNvbnN0IGMgPSB0cmVlLnBvaW50c1tpZF07XG4gICAgICAgICAgICBjbHVzdGVycy5wdXNoKGMubnVtUG9pbnRzID8gZ2V0Q2x1c3RlckpTT04oYykgOiB0aGlzLnBvaW50c1tjLmluZGV4XSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGNsdXN0ZXJzO1xuICAgIH1cblxuICAgIGdldENoaWxkcmVuKGNsdXN0ZXJJZCkge1xuICAgICAgICBjb25zdCBvcmlnaW5JZCA9IHRoaXMuX2dldE9yaWdpbklkKGNsdXN0ZXJJZCk7XG4gICAgICAgIGNvbnN0IG9yaWdpblpvb20gPSB0aGlzLl9nZXRPcmlnaW5ab29tKGNsdXN0ZXJJZCk7XG4gICAgICAgIGNvbnN0IGVycm9yTXNnID0gJ05vIGNsdXN0ZXIgd2l0aCB0aGUgc3BlY2lmaWVkIGlkLic7XG5cbiAgICAgICAgY29uc3QgaW5kZXggPSB0aGlzLnRyZWVzW29yaWdpblpvb21dO1xuICAgICAgICBpZiAoIWluZGV4KSB0aHJvdyBuZXcgRXJyb3IoZXJyb3JNc2cpO1xuXG4gICAgICAgIGNvbnN0IG9yaWdpbiA9IGluZGV4LnBvaW50c1tvcmlnaW5JZF07XG4gICAgICAgIGlmICghb3JpZ2luKSB0aHJvdyBuZXcgRXJyb3IoZXJyb3JNc2cpO1xuXG4gICAgICAgIGNvbnN0IHIgPSB0aGlzLm9wdGlvbnMucmFkaXVzIC8gKHRoaXMub3B0aW9ucy5leHRlbnQgKiBNYXRoLnBvdygyLCBvcmlnaW5ab29tIC0gMSkpO1xuICAgICAgICBjb25zdCBpZHMgPSBpbmRleC53aXRoaW4ob3JpZ2luLngsIG9yaWdpbi55LCByKTtcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBpZCBvZiBpZHMpIHtcbiAgICAgICAgICAgIGNvbnN0IGMgPSBpbmRleC5wb2ludHNbaWRdO1xuICAgICAgICAgICAgaWYgKGMucGFyZW50SWQgPT09IGNsdXN0ZXJJZCkge1xuICAgICAgICAgICAgICAgIGNoaWxkcmVuLnB1c2goYy5udW1Qb2ludHMgPyBnZXRDbHVzdGVySlNPTihjKSA6IHRoaXMucG9pbnRzW2MuaW5kZXhdKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjaGlsZHJlbi5sZW5ndGggPT09IDApIHRocm93IG5ldyBFcnJvcihlcnJvck1zZyk7XG5cbiAgICAgICAgcmV0dXJuIGNoaWxkcmVuO1xuICAgIH1cblxuICAgIGdldExlYXZlcyhjbHVzdGVySWQsIGxpbWl0LCBvZmZzZXQpIHtcbiAgICAgICAgbGltaXQgPSBsaW1pdCB8fCAxMDtcbiAgICAgICAgb2Zmc2V0ID0gb2Zmc2V0IHx8IDA7XG5cbiAgICAgICAgY29uc3QgbGVhdmVzID0gW107XG4gICAgICAgIHRoaXMuX2FwcGVuZExlYXZlcyhsZWF2ZXMsIGNsdXN0ZXJJZCwgbGltaXQsIG9mZnNldCwgMCk7XG5cbiAgICAgICAgcmV0dXJuIGxlYXZlcztcbiAgICB9XG5cbiAgICBnZXRUaWxlKHosIHgsIHkpIHtcbiAgICAgICAgY29uc3QgdHJlZSA9IHRoaXMudHJlZXNbdGhpcy5fbGltaXRab29tKHopXTtcbiAgICAgICAgY29uc3QgejIgPSBNYXRoLnBvdygyLCB6KTtcbiAgICAgICAgY29uc3Qge2V4dGVudCwgcmFkaXVzfSA9IHRoaXMub3B0aW9ucztcbiAgICAgICAgY29uc3QgcCA9IHJhZGl1cyAvIGV4dGVudDtcbiAgICAgICAgY29uc3QgdG9wID0gKHkgLSBwKSAvIHoyO1xuICAgICAgICBjb25zdCBib3R0b20gPSAoeSArIDEgKyBwKSAvIHoyO1xuXG4gICAgICAgIGNvbnN0IHRpbGUgPSB7XG4gICAgICAgICAgICBmZWF0dXJlczogW11cbiAgICAgICAgfTtcblxuICAgICAgICB0aGlzLl9hZGRUaWxlRmVhdHVyZXMoXG4gICAgICAgICAgICB0cmVlLnJhbmdlKCh4IC0gcCkgLyB6MiwgdG9wLCAoeCArIDEgKyBwKSAvIHoyLCBib3R0b20pLFxuICAgICAgICAgICAgdHJlZS5wb2ludHMsIHgsIHksIHoyLCB0aWxlKTtcblxuICAgICAgICBpZiAoeCA9PT0gMCkge1xuICAgICAgICAgICAgdGhpcy5fYWRkVGlsZUZlYXR1cmVzKFxuICAgICAgICAgICAgICAgIHRyZWUucmFuZ2UoMSAtIHAgLyB6MiwgdG9wLCAxLCBib3R0b20pLFxuICAgICAgICAgICAgICAgIHRyZWUucG9pbnRzLCB6MiwgeSwgejIsIHRpbGUpO1xuICAgICAgICB9XG4gICAgICAgIGlmICh4ID09PSB6MiAtIDEpIHtcbiAgICAgICAgICAgIHRoaXMuX2FkZFRpbGVGZWF0dXJlcyhcbiAgICAgICAgICAgICAgICB0cmVlLnJhbmdlKDAsIHRvcCwgcCAvIHoyLCBib3R0b20pLFxuICAgICAgICAgICAgICAgIHRyZWUucG9pbnRzLCAtMSwgeSwgejIsIHRpbGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRpbGUuZmVhdHVyZXMubGVuZ3RoID8gdGlsZSA6IG51bGw7XG4gICAgfVxuXG4gICAgZ2V0Q2x1c3RlckV4cGFuc2lvblpvb20oY2x1c3RlcklkKSB7XG4gICAgICAgIGxldCBleHBhbnNpb25ab29tID0gdGhpcy5fZ2V0T3JpZ2luWm9vbShjbHVzdGVySWQpIC0gMTtcbiAgICAgICAgd2hpbGUgKGV4cGFuc2lvblpvb20gPD0gdGhpcy5vcHRpb25zLm1heFpvb20pIHtcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkcmVuID0gdGhpcy5nZXRDaGlsZHJlbihjbHVzdGVySWQpO1xuICAgICAgICAgICAgZXhwYW5zaW9uWm9vbSsrO1xuICAgICAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCAhPT0gMSkgYnJlYWs7XG4gICAgICAgICAgICBjbHVzdGVySWQgPSBjaGlsZHJlblswXS5wcm9wZXJ0aWVzLmNsdXN0ZXJfaWQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGV4cGFuc2lvblpvb207XG4gICAgfVxuXG4gICAgX2FwcGVuZExlYXZlcyhyZXN1bHQsIGNsdXN0ZXJJZCwgbGltaXQsIG9mZnNldCwgc2tpcHBlZCkge1xuICAgICAgICBjb25zdCBjaGlsZHJlbiA9IHRoaXMuZ2V0Q2hpbGRyZW4oY2x1c3RlcklkKTtcblxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGNoaWxkcmVuKSB7XG4gICAgICAgICAgICBjb25zdCBwcm9wcyA9IGNoaWxkLnByb3BlcnRpZXM7XG5cbiAgICAgICAgICAgIGlmIChwcm9wcyAmJiBwcm9wcy5jbHVzdGVyKSB7XG4gICAgICAgICAgICAgICAgaWYgKHNraXBwZWQgKyBwcm9wcy5wb2ludF9jb3VudCA8PSBvZmZzZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gc2tpcCB0aGUgd2hvbGUgY2x1c3RlclxuICAgICAgICAgICAgICAgICAgICBza2lwcGVkICs9IHByb3BzLnBvaW50X2NvdW50O1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGVudGVyIHRoZSBjbHVzdGVyXG4gICAgICAgICAgICAgICAgICAgIHNraXBwZWQgPSB0aGlzLl9hcHBlbmRMZWF2ZXMocmVzdWx0LCBwcm9wcy5jbHVzdGVyX2lkLCBsaW1pdCwgb2Zmc2V0LCBza2lwcGVkKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gZXhpdCB0aGUgY2x1c3RlclxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc2tpcHBlZCA8IG9mZnNldCkge1xuICAgICAgICAgICAgICAgIC8vIHNraXAgYSBzaW5nbGUgcG9pbnRcbiAgICAgICAgICAgICAgICBza2lwcGVkKys7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIGFkZCBhIHNpbmdsZSBwb2ludFxuICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKGNoaWxkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChyZXN1bHQubGVuZ3RoID09PSBsaW1pdCkgYnJlYWs7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc2tpcHBlZDtcbiAgICB9XG5cbiAgICBfYWRkVGlsZUZlYXR1cmVzKGlkcywgcG9pbnRzLCB4LCB5LCB6MiwgdGlsZSkge1xuICAgICAgICBmb3IgKGNvbnN0IGkgb2YgaWRzKSB7XG4gICAgICAgICAgICBjb25zdCBjID0gcG9pbnRzW2ldO1xuICAgICAgICAgICAgY29uc3QgaXNDbHVzdGVyID0gYy5udW1Qb2ludHM7XG5cbiAgICAgICAgICAgIGxldCB0YWdzLCBweCwgcHk7XG4gICAgICAgICAgICBpZiAoaXNDbHVzdGVyKSB7XG4gICAgICAgICAgICAgICAgdGFncyA9IGdldENsdXN0ZXJQcm9wZXJ0aWVzKGMpO1xuICAgICAgICAgICAgICAgIHB4ID0gYy54O1xuICAgICAgICAgICAgICAgIHB5ID0gYy55O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb25zdCBwID0gdGhpcy5wb2ludHNbYy5pbmRleF07XG4gICAgICAgICAgICAgICAgdGFncyA9IHAucHJvcGVydGllcztcbiAgICAgICAgICAgICAgICBweCA9IGxuZ1gocC5nZW9tZXRyeS5jb29yZGluYXRlc1swXSk7XG4gICAgICAgICAgICAgICAgcHkgPSBsYXRZKHAuZ2VvbWV0cnkuY29vcmRpbmF0ZXNbMV0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBmID0ge1xuICAgICAgICAgICAgICAgIHR5cGU6IDEsXG4gICAgICAgICAgICAgICAgZ2VvbWV0cnk6IFtbXG4gICAgICAgICAgICAgICAgICAgIE1hdGgucm91bmQodGhpcy5vcHRpb25zLmV4dGVudCAqIChweCAqIHoyIC0geCkpLFxuICAgICAgICAgICAgICAgICAgICBNYXRoLnJvdW5kKHRoaXMub3B0aW9ucy5leHRlbnQgKiAocHkgKiB6MiAtIHkpKVxuICAgICAgICAgICAgICAgIF1dLFxuICAgICAgICAgICAgICAgIHRhZ3NcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIC8vIGFzc2lnbiBpZFxuICAgICAgICAgICAgbGV0IGlkO1xuICAgICAgICAgICAgaWYgKGlzQ2x1c3Rlcikge1xuICAgICAgICAgICAgICAgIGlkID0gYy5pZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5vcHRpb25zLmdlbmVyYXRlSWQpIHtcbiAgICAgICAgICAgICAgICAvLyBvcHRpb25hbGx5IGdlbmVyYXRlIGlkXG4gICAgICAgICAgICAgICAgaWQgPSBjLmluZGV4O1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLnBvaW50c1tjLmluZGV4XS5pZCkge1xuICAgICAgICAgICAgICAgIC8vIGtlZXAgaWQgaWYgYWxyZWFkeSBhc3NpZ25lZFxuICAgICAgICAgICAgICAgIGlkID0gdGhpcy5wb2ludHNbYy5pbmRleF0uaWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpZCAhPT0gdW5kZWZpbmVkKSBmLmlkID0gaWQ7XG5cbiAgICAgICAgICAgIHRpbGUuZmVhdHVyZXMucHVzaChmKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9saW1pdFpvb20oeikge1xuICAgICAgICByZXR1cm4gTWF0aC5tYXgodGhpcy5vcHRpb25zLm1pblpvb20sIE1hdGgubWluKCt6LCB0aGlzLm9wdGlvbnMubWF4Wm9vbSArIDEpKTtcbiAgICB9XG5cbiAgICBfY2x1c3Rlcihwb2ludHMsIHpvb20pIHtcbiAgICAgICAgY29uc3QgY2x1c3RlcnMgPSBbXTtcbiAgICAgICAgY29uc3Qge3JhZGl1cywgZXh0ZW50LCByZWR1Y2UsIG1pblBvaW50c30gPSB0aGlzLm9wdGlvbnM7XG4gICAgICAgIGNvbnN0IHIgPSByYWRpdXMgLyAoZXh0ZW50ICogTWF0aC5wb3coMiwgem9vbSkpO1xuXG4gICAgICAgIC8vIGxvb3AgdGhyb3VnaCBlYWNoIHBvaW50XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcG9pbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBjb25zdCBwID0gcG9pbnRzW2ldO1xuICAgICAgICAgICAgLy8gaWYgd2UndmUgYWxyZWFkeSB2aXNpdGVkIHRoZSBwb2ludCBhdCB0aGlzIHpvb20gbGV2ZWwsIHNraXAgaXRcbiAgICAgICAgICAgIGlmIChwLnpvb20gPD0gem9vbSkgY29udGludWU7XG4gICAgICAgICAgICBwLnpvb20gPSB6b29tO1xuXG4gICAgICAgICAgICAvLyBmaW5kIGFsbCBuZWFyYnkgcG9pbnRzXG4gICAgICAgICAgICBjb25zdCB0cmVlID0gdGhpcy50cmVlc1t6b29tICsgMV07XG4gICAgICAgICAgICBjb25zdCBuZWlnaGJvcklkcyA9IHRyZWUud2l0aGluKHAueCwgcC55LCByKTtcblxuICAgICAgICAgICAgY29uc3QgbnVtUG9pbnRzT3JpZ2luID0gcC5udW1Qb2ludHMgfHwgMTtcbiAgICAgICAgICAgIGxldCBudW1Qb2ludHMgPSBudW1Qb2ludHNPcmlnaW47XG5cbiAgICAgICAgICAgIC8vIGNvdW50IHRoZSBudW1iZXIgb2YgcG9pbnRzIGluIGEgcG90ZW50aWFsIGNsdXN0ZXJcbiAgICAgICAgICAgIGZvciAoY29uc3QgbmVpZ2hib3JJZCBvZiBuZWlnaGJvcklkcykge1xuICAgICAgICAgICAgICAgIGNvbnN0IGIgPSB0cmVlLnBvaW50c1tuZWlnaGJvcklkXTtcbiAgICAgICAgICAgICAgICAvLyBmaWx0ZXIgb3V0IG5laWdoYm9ycyB0aGF0IGFyZSBhbHJlYWR5IHByb2Nlc3NlZFxuICAgICAgICAgICAgICAgIGlmIChiLnpvb20gPiB6b29tKSBudW1Qb2ludHMgKz0gYi5udW1Qb2ludHMgfHwgMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gaWYgdGhlcmUgd2VyZSBuZWlnaGJvcnMgdG8gbWVyZ2UsIGFuZCB0aGVyZSBhcmUgZW5vdWdoIHBvaW50cyB0byBmb3JtIGEgY2x1c3RlclxuICAgICAgICAgICAgaWYgKG51bVBvaW50cyA+IG51bVBvaW50c09yaWdpbiAmJiBudW1Qb2ludHMgPj0gbWluUG9pbnRzKSB7XG4gICAgICAgICAgICAgICAgbGV0IHd4ID0gcC54ICogbnVtUG9pbnRzT3JpZ2luO1xuICAgICAgICAgICAgICAgIGxldCB3eSA9IHAueSAqIG51bVBvaW50c09yaWdpbjtcblxuICAgICAgICAgICAgICAgIGxldCBjbHVzdGVyUHJvcGVydGllcyA9IHJlZHVjZSAmJiBudW1Qb2ludHNPcmlnaW4gPiAxID8gdGhpcy5fbWFwKHAsIHRydWUpIDogbnVsbDtcblxuICAgICAgICAgICAgICAgIC8vIGVuY29kZSBib3RoIHpvb20gYW5kIHBvaW50IGluZGV4IG9uIHdoaWNoIHRoZSBjbHVzdGVyIG9yaWdpbmF0ZWQgLS0gb2Zmc2V0IGJ5IHRvdGFsIGxlbmd0aCBvZiBmZWF0dXJlc1xuICAgICAgICAgICAgICAgIGNvbnN0IGlkID0gKGkgPDwgNSkgKyAoem9vbSArIDEpICsgdGhpcy5wb2ludHMubGVuZ3RoO1xuXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBuZWlnaGJvcklkIG9mIG5laWdoYm9ySWRzKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGIgPSB0cmVlLnBvaW50c1tuZWlnaGJvcklkXTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYi56b29tIDw9IHpvb20pIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgICAgICBiLnpvb20gPSB6b29tOyAvLyBzYXZlIHRoZSB6b29tIChzbyBpdCBkb2Vzbid0IGdldCBwcm9jZXNzZWQgdHdpY2UpXG5cbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbnVtUG9pbnRzMiA9IGIubnVtUG9pbnRzIHx8IDE7XG4gICAgICAgICAgICAgICAgICAgIHd4ICs9IGIueCAqIG51bVBvaW50czI7IC8vIGFjY3VtdWxhdGUgY29vcmRpbmF0ZXMgZm9yIGNhbGN1bGF0aW5nIHdlaWdodGVkIGNlbnRlclxuICAgICAgICAgICAgICAgICAgICB3eSArPSBiLnkgKiBudW1Qb2ludHMyO1xuXG4gICAgICAgICAgICAgICAgICAgIGIucGFyZW50SWQgPSBpZDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAocmVkdWNlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNsdXN0ZXJQcm9wZXJ0aWVzKSBjbHVzdGVyUHJvcGVydGllcyA9IHRoaXMuX21hcChwLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZHVjZShjbHVzdGVyUHJvcGVydGllcywgdGhpcy5fbWFwKGIpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHAucGFyZW50SWQgPSBpZDtcbiAgICAgICAgICAgICAgICBjbHVzdGVycy5wdXNoKGNyZWF0ZUNsdXN0ZXIod3ggLyBudW1Qb2ludHMsIHd5IC8gbnVtUG9pbnRzLCBpZCwgbnVtUG9pbnRzLCBjbHVzdGVyUHJvcGVydGllcykpO1xuXG4gICAgICAgICAgICB9IGVsc2UgeyAvLyBsZWZ0IHBvaW50cyBhcyB1bmNsdXN0ZXJlZFxuICAgICAgICAgICAgICAgIGNsdXN0ZXJzLnB1c2gocCk7XG5cbiAgICAgICAgICAgICAgICBpZiAobnVtUG9pbnRzID4gMSkge1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IG5laWdoYm9ySWQgb2YgbmVpZ2hib3JJZHMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGIgPSB0cmVlLnBvaW50c1tuZWlnaGJvcklkXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiLnpvb20gPD0gem9vbSkgY29udGludWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBiLnpvb20gPSB6b29tO1xuICAgICAgICAgICAgICAgICAgICAgICAgY2x1c3RlcnMucHVzaChiKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjbHVzdGVycztcbiAgICB9XG5cbiAgICAvLyBnZXQgaW5kZXggb2YgdGhlIHBvaW50IGZyb20gd2hpY2ggdGhlIGNsdXN0ZXIgb3JpZ2luYXRlZFxuICAgIF9nZXRPcmlnaW5JZChjbHVzdGVySWQpIHtcbiAgICAgICAgcmV0dXJuIChjbHVzdGVySWQgLSB0aGlzLnBvaW50cy5sZW5ndGgpID4+IDU7XG4gICAgfVxuXG4gICAgLy8gZ2V0IHpvb20gb2YgdGhlIHBvaW50IGZyb20gd2hpY2ggdGhlIGNsdXN0ZXIgb3JpZ2luYXRlZFxuICAgIF9nZXRPcmlnaW5ab29tKGNsdXN0ZXJJZCkge1xuICAgICAgICByZXR1cm4gKGNsdXN0ZXJJZCAtIHRoaXMucG9pbnRzLmxlbmd0aCkgJSAzMjtcbiAgICB9XG5cbiAgICBfbWFwKHBvaW50LCBjbG9uZSkge1xuICAgICAgICBpZiAocG9pbnQubnVtUG9pbnRzKSB7XG4gICAgICAgICAgICByZXR1cm4gY2xvbmUgPyBleHRlbmQoe30sIHBvaW50LnByb3BlcnRpZXMpIDogcG9pbnQucHJvcGVydGllcztcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBvcmlnaW5hbCA9IHRoaXMucG9pbnRzW3BvaW50LmluZGV4XS5wcm9wZXJ0aWVzO1xuICAgICAgICBjb25zdCByZXN1bHQgPSB0aGlzLm9wdGlvbnMubWFwKG9yaWdpbmFsKTtcbiAgICAgICAgcmV0dXJuIGNsb25lICYmIHJlc3VsdCA9PT0gb3JpZ2luYWwgPyBleHRlbmQoe30sIHJlc3VsdCkgOiByZXN1bHQ7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBjcmVhdGVDbHVzdGVyKHgsIHksIGlkLCBudW1Qb2ludHMsIHByb3BlcnRpZXMpIHtcbiAgICByZXR1cm4ge1xuICAgICAgICB4OiBmcm91bmQoeCksIC8vIHdlaWdodGVkIGNsdXN0ZXIgY2VudGVyOyByb3VuZCBmb3IgY29uc2lzdGVuY3kgd2l0aCBGbG9hdDMyQXJyYXkgaW5kZXhcbiAgICAgICAgeTogZnJvdW5kKHkpLFxuICAgICAgICB6b29tOiBJbmZpbml0eSwgLy8gdGhlIGxhc3Qgem9vbSB0aGUgY2x1c3RlciB3YXMgcHJvY2Vzc2VkIGF0XG4gICAgICAgIGlkLCAvLyBlbmNvZGVzIGluZGV4IG9mIHRoZSBmaXJzdCBjaGlsZCBvZiB0aGUgY2x1c3RlciBhbmQgaXRzIHpvb20gbGV2ZWxcbiAgICAgICAgcGFyZW50SWQ6IC0xLCAvLyBwYXJlbnQgY2x1c3RlciBpZFxuICAgICAgICBudW1Qb2ludHMsXG4gICAgICAgIHByb3BlcnRpZXNcbiAgICB9O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVQb2ludENsdXN0ZXIocCwgaWQpIHtcbiAgICBjb25zdCBbeCwgeV0gPSBwLmdlb21ldHJ5LmNvb3JkaW5hdGVzO1xuICAgIHJldHVybiB7XG4gICAgICAgIHg6IGZyb3VuZChsbmdYKHgpKSwgLy8gcHJvamVjdGVkIHBvaW50IGNvb3JkaW5hdGVzXG4gICAgICAgIHk6IGZyb3VuZChsYXRZKHkpKSxcbiAgICAgICAgem9vbTogSW5maW5pdHksIC8vIHRoZSBsYXN0IHpvb20gdGhlIHBvaW50IHdhcyBwcm9jZXNzZWQgYXRcbiAgICAgICAgaW5kZXg6IGlkLCAvLyBpbmRleCBvZiB0aGUgc291cmNlIGZlYXR1cmUgaW4gdGhlIG9yaWdpbmFsIGlucHV0IGFycmF5LFxuICAgICAgICBwYXJlbnRJZDogLTEgLy8gcGFyZW50IGNsdXN0ZXIgaWRcbiAgICB9O1xufVxuXG5mdW5jdGlvbiBnZXRDbHVzdGVySlNPTihjbHVzdGVyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogJ0ZlYXR1cmUnLFxuICAgICAgICBpZDogY2x1c3Rlci5pZCxcbiAgICAgICAgcHJvcGVydGllczogZ2V0Q2x1c3RlclByb3BlcnRpZXMoY2x1c3RlciksXG4gICAgICAgIGdlb21ldHJ5OiB7XG4gICAgICAgICAgICB0eXBlOiAnUG9pbnQnLFxuICAgICAgICAgICAgY29vcmRpbmF0ZXM6IFt4TG5nKGNsdXN0ZXIueCksIHlMYXQoY2x1c3Rlci55KV1cbiAgICAgICAgfVxuICAgIH07XG59XG5cbmZ1bmN0aW9uIGdldENsdXN0ZXJQcm9wZXJ0aWVzKGNsdXN0ZXIpIHtcbiAgICBjb25zdCBjb3VudCA9IGNsdXN0ZXIubnVtUG9pbnRzO1xuICAgIGNvbnN0IGFiYnJldiA9XG4gICAgICAgIGNvdW50ID49IDEwMDAwID8gYCR7TWF0aC5yb3VuZChjb3VudCAvIDEwMDApICB9a2AgOlxuICAgICAgICBjb3VudCA+PSAxMDAwID8gYCR7TWF0aC5yb3VuZChjb3VudCAvIDEwMCkgLyAxMCAgfWtgIDogY291bnQ7XG4gICAgcmV0dXJuIGV4dGVuZChleHRlbmQoe30sIGNsdXN0ZXIucHJvcGVydGllcyksIHtcbiAgICAgICAgY2x1c3RlcjogdHJ1ZSxcbiAgICAgICAgY2x1c3Rlcl9pZDogY2x1c3Rlci5pZCxcbiAgICAgICAgcG9pbnRfY291bnQ6IGNvdW50LFxuICAgICAgICBwb2ludF9jb3VudF9hYmJyZXZpYXRlZDogYWJicmV2XG4gICAgfSk7XG59XG5cbi8vIGxvbmdpdHVkZS9sYXRpdHVkZSB0byBzcGhlcmljYWwgbWVyY2F0b3IgaW4gWzAuLjFdIHJhbmdlXG5mdW5jdGlvbiBsbmdYKGxuZykge1xuICAgIHJldHVybiBsbmcgLyAzNjAgKyAwLjU7XG59XG5mdW5jdGlvbiBsYXRZKGxhdCkge1xuICAgIGNvbnN0IHNpbiA9IE1hdGguc2luKGxhdCAqIE1hdGguUEkgLyAxODApO1xuICAgIGNvbnN0IHkgPSAoMC41IC0gMC4yNSAqIE1hdGgubG9nKCgxICsgc2luKSAvICgxIC0gc2luKSkgLyBNYXRoLlBJKTtcbiAgICByZXR1cm4geSA8IDAgPyAwIDogeSA+IDEgPyAxIDogeTtcbn1cblxuLy8gc3BoZXJpY2FsIG1lcmNhdG9yIHRvIGxvbmdpdHVkZS9sYXRpdHVkZVxuZnVuY3Rpb24geExuZyh4KSB7XG4gICAgcmV0dXJuICh4IC0gMC41KSAqIDM2MDtcbn1cbmZ1bmN0aW9uIHlMYXQoeSkge1xuICAgIGNvbnN0IHkyID0gKDE4MCAtIHkgKiAzNjApICogTWF0aC5QSSAvIDE4MDtcbiAgICByZXR1cm4gMzYwICogTWF0aC5hdGFuKE1hdGguZXhwKHkyKSkgLyBNYXRoLlBJIC0gOTA7XG59XG5cbmZ1bmN0aW9uIGV4dGVuZChkZXN0LCBzcmMpIHtcbiAgICBmb3IgKGNvbnN0IGlkIGluIHNyYykgZGVzdFtpZF0gPSBzcmNbaWRdO1xuICAgIHJldHVybiBkZXN0O1xufVxuXG5mdW5jdGlvbiBnZXRYKHApIHtcbiAgICByZXR1cm4gcC54O1xufVxuZnVuY3Rpb24gZ2V0WShwKSB7XG4gICAgcmV0dXJuIHAueTtcbn1cbiIsbnVsbCxudWxsXSwibmFtZXMiOlsicmVmUHJvcGVydGllcyIsImNyZWF0ZVN0eWxlTGF5ZXIiLCJmZWF0dXJlRmlsdGVyIiwicG90cGFjayIsIkFscGhhSW1hZ2UiLCJyZWdpc3RlciIsIk92ZXJzY2FsZWRUaWxlSUQiLCJDb2xsaXNpb25Cb3hBcnJheSIsIkRpY3Rpb25hcnlDb2RlciIsIkZlYXR1cmVJbmRleCIsIndhcm5PbmNlIiwiYXNzZXJ0IiwibWFwT2JqZWN0IiwiSW1hZ2VBdGxhcyIsIlN5bWJvbEJ1Y2tldCIsInBlcmZvcm1TeW1ib2xMYXlvdXQiLCJMaW5lQnVja2V0IiwiRmlsbEJ1Y2tldCIsIkZpbGxFeHRydXNpb25CdWNrZXQiLCJFdmFsdWF0aW9uUGFyYW1ldGVycyIsImdldEFycmF5QnVmZmVyIiwidnQiLCJQcm90b2J1ZiIsIlJlcXVlc3RQZXJmb3JtYW5jZSIsImV4dGVuZCIsInJlcXVpcmUkJDAiLCJyZXF1aXJlJCQxIiwiR2VvSlNPTldyYXBwZXIiLCJGZWF0dXJlV3JhcHBlciIsInZ0UGJmTW9kdWxlIiwicmV3aW5kIiwidHJhbnNmb3JtIiwibXZ0IiwiRVhURU5UIiwiUG9pbnQiLCJnZW9qc29uVnQiLCJpc0ltYWdlQml0bWFwIiwiREVNRGF0YSIsIlJHQkFJbWFnZSIsInNvcnQiLCJjcmVhdGVFeHByZXNzaW9uIiwiZ2V0SlNPTiIsIkFjdG9yIiwiZ2xvYmFsUlRMVGV4dFBsdWdpbiIsImVuZm9yY2VDYWNoZVNpemVMaW1pdCJdLCJtYXBwaW5ncyI6Ijs7QUFHQSxTQUFTLFNBQVMsQ0FBQyxHQUFHO0lBQ2xCLE1BQU0sSUFBSSxHQUFHLE9BQU8sR0FBRyxDQUFDO0lBQ3hCLElBQUksSUFBSSxL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LENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzdFLGFBQWE7QUFDYixTQUFTO0FBQ1QsUUFBUSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQ2YsUUFBUSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQ2YsS0FBSztBQUNMO0FBQ0EsSUFBSSxJQUFJLElBQUksR0FBRyxHQUFHLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQztBQUM5QixJQUFJLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDZixJQUFJLFFBQVEsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxFQUFFLElBQUksRUFBRSxTQUFTLENBQUMsQ0FBQztBQUN0QyxJQUFJLEdBQUcsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3RCO0FBQ0EsSUFBSSxHQUFHLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDOUIsSUFBSSxHQUFHLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQztBQUNsQixJQUFJLEdBQUcsQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQztBQUN2QixDQUFDO0FBQ0Q7QUFDQSxTQUFTLFlBQVksQ0FBQyxLQUFLLEVBQUUsR0FBRyxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUU7QUFDeEQsSUFBSSxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtBQUMzQyxRQUFRLElBQUksSUFBSSxHQUFHLEVBQUUsQ0FBQztBQUN0QixRQUFRLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLFNBQVMsRUFBRSxTQUFTLENBQUMsQ0FBQztBQUMxRCxRQUFRLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDdkIsS0FBSztBQUNMLENB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QUNMO0FBQ0E7QUFDQSxJQUFJLElBQUksSUFBSSxHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO0FBQy9CLElBQUksRUFBRSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNwQixJQUFJLEVBQUUsR0FBRyxJQUFJLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ3hCLElBQUksRUFBRSxHQUFHLElBQUksQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDeEIsSUFBSSxDQUFDLEdBQUcsSUFBSSxLQUFLLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDO0FBQzdCLElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLEVBQUUsUUFBUSxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ3hEO0FBQ0E7QUFDQSxJQUFJLElBQUksR0FBRyxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQztBQUM1QixJQUFJLElBQUksU0FBUyxJQUFJLElBQUksSUFBSSxDQUFDLEtBQUssS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxLQUFLLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQzlGLFFBQVEsUUFBUSxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3RELEtBQUs7QUFDTDtBQUNBO0FBQ0EsSUFBSSxJQUFJLEtBQUssQ0FBQyxNQUFNLEVBQUU7QUFDdEIsUUFBUSxPQUFPLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQzVCLEtBQUs7QUFDTCxDQUFDO0FBQ0Q7QUFDQSxTQUFTLFFBQVEsQ0FBQyxJQUFJLEVBQUU7QUFDeEIsSUFBSSxJQUFJ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RSxDQUFDLElBQUksQ0FBQyxFQUFFO0FBQzVFLFFBQVEsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNsRSxLQUFLO0FBQ0wsSUFBSSxJQUFJLElBQUksR0FBRyxDQUFDLEtBQUssU0FBUyxFQUFFO0FBQ2hDLFFBQVEsS0FBSyxDQUFDLEdBQUcsQ0FBQyxFQUFFLEdBQUcsR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsR0FBRyxHQUFHLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUU7QUFDNUQsWUFBWSxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDNUIsWUFBWSxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ2hDLFlBQVksSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ3hDLFlBQVksSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUM1QyxZQUFZLElBQUksQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNsQyxZQUFZLElBQUksQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNsQyxTQUFTO0FBQ1QsS0FBSztBQUNMOztBQ3hIZSxTQUFTLFNBQVMsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFO0FBQ2pELElBQUksT0FBTyxJQUFJLFNBQVMsQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUM7QUFDeEMsQ0FBQztBQUNE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LENBQUMsUUFBUSxFQUFFLEVBQUUsRUFBRSxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQztBQUNyRixRQUFRLFFBQVEsR0FBRyxJQUFJLENBQUM7QUFDeEI7QUFDQSxRQUFRLElBQUksSUFBSSxFQUFFO0FBQ2xCLFlBQVksRUFBRSxHQUFHLElBQUksQ0FBQyxJQUFJLEVBQUUsRUFBRSxFQUFFLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQ2xGLFlBQVksRUFBRSxHQUFHLElBQUksQ0FBQyxJQUFJLEVBQUUsRUFBRSxFQUFFLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQ2xGLFlBQVksSUFBSSxHQUFHLElBQUksQ0FBQztBQUN4QixTQUFTO0FBQ1Q7QUFDQSxRQUFRLElBQUksS0FBSyxFQUFFO0FBQ25CLFlBQVksRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQ25GLFlBQVksRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0FBQ25GLFlBQVksS0FBSyxHQUFHLElBQUksQ0FBQztBQUN6QixTQUFTO0FBQ1Q7QUFDQSxRQUFRLElBQUksS0FBSyxHQUFHLENBQUMsRUFBRSxPQUFPLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0FBQ25EO0FBQ0EsUUFBUSxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUN0RCxRQUFRLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUMxRCxRQUFRLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUN0RCxRQUFRLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDMUQsS0FBSztBQUNMLENBQUMsQ0FBQztBQUNGO0FBQ0EsU0FBUyxDQUFDLFNBQVMsQ0FBQyxPQUFPLEdBQUcsVUFBVSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRTtBQUNqRCxJQUFJLElBQUksT0FBTyxHQUFHLElBQUksQ0FBQyxPQUFPO0FBQzlCLFFBQVEsTUFBTSxHQUFHLE9BQU8sQ0FBQyxNQUFNO0FBQy9CLFFBQVEsS0FBSyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUM7QUFDOUI7QUFDQSxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxFQUFFLE9BQU8s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QUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzQyxJQUFJLElBQUksQ0FBQyxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdkMsSUFBSSxJQUFJLENBQUMsR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzQyxJQUFJLElBQUksQ0FBQyxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdkMsSUFBSSxPQUFPLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDeEIsQ0FBQztBQUNEO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxTQUFTLGFBQWEsQ0FBQyxJQUFJLEVBQUU7QUFDN0IsSUFBSSxJQUFJLElBQUksR0FBRyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDaEMsSUFBSSxJQUFJLElBQUksR0FBRztBQUNmLFFBQVEsSUFBSSxFQUFFLFNBQVM7QUFDdkIsUUFBUSxXQUFXLEVBQUUsQ0FBQztBQUN0QixZQUFZLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM5QixZQUFZLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM5QixZQUFZLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM5QixZQUFZLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM5QixZQUFZLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM5QixTQUFTLENBQUM7QUFDVixLQUFLLENBQUM7QUFDTixJQUFJLE9BQU8sSUFBSSxDQUFDO0FBQ2hCLENBQUM7QUFDRDtBQUNBLFNBQVMsUUFBUSxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUU7QUFDeEIsSUFBSSxPQUFPLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsR0FBRyxHQUFHLEdBQUcsR0FBRyxDQUFDO0FBQzFDLENBQUM7QUFDRDtBQUNBLFNBQVMsUUFBUSxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUU7QUFDeEIsSUFBSSxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMsRUFBRSxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUMsRUFBRSxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztBQUN2RCxJQUFJLE9BQU8sR0FBRyxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMvRCxDQUFDO0FBQ0Q7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxTQUFTLFdBQVcsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLENBQUMsRUFBRTtBQUNsQyxJQUFJLElBQUksSUFBSSxHQUFHLG1CQUFtQixDQUFDLEdBQUcsRUFBRSxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDaEQsSUFBSSxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNsQyxJQUFJLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xDLElBQUksT0FBTyxJQUFJLENBQUM7QUFDaEIsQ0FBQztBQUNEO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxTQUFTLFdBQVcsQ0FBQyxJQUFJLEVBQUU7QUFDM0IsSUFBSSxPQUFPO0FBQ1gsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQy9DLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDcEQsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDdkQsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNuRCxLQUFLLENBQUM7QUFDTixDQUFDO0FBQ0Q7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFNBQVMsU0FBUyxDQUFDLElBQUksRUFBRTtBQUN6QixJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ3JELENBQUM7QUFDRDtBQUNBLFNBQVMsV0FBVyxDQUFDLElBQUksRUFBRTtBQUMzQixJQUFJLE9BQU8sV0FBVyxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ3hDLENBQUM7QUFDRDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsU0FBUyxXQUFXLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRTtBQUNsQyxJQUFJLElBQUksUUFBUSxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNyQyxJQUFJLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxRQUFRLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO0FBQzlDLFFBQVEsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsT0FBTyxLQUFLLENBQUM7QUFDdkQsS0FBSztBQUNMLElBQUksT0FBTyxJQUFJLENBQUM7QUFDaEIsQ0FBQztBQUNEO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFNBQVMsT0FBTyxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUU7QUFDOUIsSUFBSSxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRTtBQUMzQyxRQUFRLElBQUksVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsRUFBRSxPQUFPLElBQUksQ0FBQztBQUNwRCxLQUFLO0FBQ0wsSUFBSSxPQUFPLEtBQUssQ0FBQztBQUNqQixDQUFDO0FBQ0Q7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsU0FBUyxVQUFVLENBQUMsS0FBSyxFQUFFLEtBQUssRUFBRTtBQUNsQyxJQUFJO0FBQ0osUUFBUSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssS0FBSyxDQUFDLENBQUMsQ0FBQztBQUM3QixRQUFRLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQzdCLFFBQVEsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDN0IsTUFBTTtBQUNOLENBQUM7QUFDRDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsU0FBUyxhQUFhLENBQUMsSUFBSSxFQUFFO0FBQzdCLElBQUksSUFBSSxLQUFLLEdBQUcsRUFBRSxDQUFDO0FBQ25CLElBQUksS0FBSyxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRTtBQUN0QyxRQUFRLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNsQixRQUFRLElBQUksSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDaEMsUUFBUSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksTUFBTSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUM7QUFDeEMsUUFBUSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksTUFBTSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUMzQyxRQUFRLEtBQUssSUFBSSxDQUFDLENBQUMsUUFBUSxFQUFFLENBQUM7QUFDOUIsS0FBSztBQUNMLElBQUksT0FBTyxLQUFLLENBQUM7QUFDakIsQ0FBQztBQUNEO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFD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QUMsR0FBRyxHQUFHLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxHQUFHLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxFQUFFO0FBQ3RFLFFBQVEsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN0RSxRQUFRLElBQUksQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLENBQUM7QUFDekIsUUFBUSxHQUFHLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxDQUFDO0FBQzNFLFFBQVEsSUFBSSxHQUFHLENBQUMsQ0FBQztBQUNqQixLQUFLO0FBQ0wsSUFBSSxJQUFJLElBQUksR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBQ2xEOztBQzFDZSxTQUFTLE1BQU0sQ0FBQyxHQUFHLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRTtBQUMxRSxJQUFJLElBQUksS0FBSyxHQUFHLElBQUksSUFBSSxRQUFRLEVBQUUsT0FBTztBQUN6QztBQUNBLElBQUksTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEdBQUcsS0FBSyxLQUFLLENBQUMsQ0FBQztBQUNsQztBQUNBLElBQUksTUFBTSxDQUFDLEdBQUcsRUFBRSxNQUFNLEVBQUUsQ0FBQyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ25EO0FBQ0EsSUFBSSxNQUFNLENBQUMsR0FBRyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQzFELElBQUksTUFBTSxDQUFDLEdBQUcsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsS0FBSyxFQUFFLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQztBQUMzRCxDQUFDO0FBQ0Q7QUFDQSxTQUFTLE1BQU0sQ0FBQyxHQUFHLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLEdBQUcsRUFBRTtBQUNsRDtBQUNBLElBQUksT0FBTyxLQUFLLEdBQUcsSUFBSSxFQUFFO0FBQ3pCLFFBQVEsSUFBSSxLQUFLLEdBQUcsSUFBSSxHQUFHLEdBQUcsRUFBRTtBQUNoQyxZQUFZLE1BQU0sQ0FBQyxHQUFHLEtBQUssR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDO0FBQ3ZDLFlBQVksTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLENBQUM7QUFDbkMsWUFBWSxNQUFNLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xDLFlBQVksTUFBTSxDQUFDLEdBQUcsR0FBRyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUNoRCxZQUFZLE1BQU0sRUFBRSxHQUFHLEdBQUcsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUN2RixZQUFZLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMs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LENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzFGLGFBQWE7QUFDYixZQUFZLFNBQVM7QUFDckIsU0FBUztBQUNUO0FBQ0EsUUFBUSxNQUFNLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxHQUFHLEtBQUssSUFBSSxDQUFDLENBQUMsQ0FBQztBQUNqRDtBQUNBLFFBQVEsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDMUIsUUFBUSxDQUFDLEdBQUcsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDOUI7QUFDQSxRQUFRLElBQUksQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDLElBQUksSUFBSSxJQUFJLENBQUMsSUFBSSxJQUFJLElBQUksQ0FBQyxJQUFJLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xGO0FBQ0EsUUFBUSxNQUFNLFFBQVEsR0FBRyxDQUFDLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3hDO0FBQ0EsUUFBUSxJQUFJLElBQUksS0FBSyxDQUFDLEdBQUcsSUFBSSxJQUFJLENBQUMsR0FBRyxJQUFJLElBQUksQ0FBQyxFQUFFO0FBQ2hELFlBQVksS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUM3QixZQUFZLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQzlCLFlBQVksS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUNqQyxTQUFTO0FBQ1QsUUFBUSxJQUFJLElBQUksS0FBSyxDQUFDLEdBQUcsSUFBSSxJQUFJLENBQUMsR0FBRyxJQUFJLElBQUksQ0FBQyxFQUFFO0FBQ2hELFlBQVksS0FBSyxDQUFDLElB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QUFDakUsUUFBUSxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksU0FBUyxDQUFDLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDdEU7QUFDQSxRQUFRLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUMsRUFBRSxFQUFFO0FBQ2hELFlBQVksR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN2QixZQUFZLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzVDLFlBQVksTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2hELFNBQVM7QUFDVDtBQUNBLFFBQVFDLE1BQUksQ0FBQyxHQUFHLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxDQUFDLEVBQUUsR0FBRyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDMUQsS0FBSztBQUNMO0FBQ0EsSUFBSSxLQUFLLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFO0FBQ2xDLFFBQVEsT0FBTyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDbkYsS0FBSztBQUNMO0FBQ0EsSUFBSSxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUU7QUFDcEIsUUFBUSxPQUFPLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFD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LElBQUksR0FBRyxHQUFHLEdBQUcsQ0FBQztBQUN2RixRQUFRLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM1RDtBQUNBLFFBQVEsSUFBSSxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLEdBQUcsRUFBRTtBQUN0QyxZQUFZLE1BQU0sR0FBRyxDQUFDLEdBQUcsQ0FBQztBQUMxQixZQUFZLE1BQU0sR0FBRyxHQUFHLENBQUM7QUFDekIsU0FBUyxNQUFNLElBQUksTUFBTSxHQUFHLE1BQU0sRUFBRTtBQUNwQyxZQUFZLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxNQUFNLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxNQUFNLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQztBQUNyRixZQUFZLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLEdBQUcsRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO0FBQ3RGLFlBQVksT0FBTyxVQUFVLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDO0FBQ2pELFNBQVM7QUFDVDtBQUNBLFFBQVEsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDdkQsUUFBUSxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQ3ZGLFFBQVEsTUFBTSxRQUFRLEdBQUcsRUFB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
