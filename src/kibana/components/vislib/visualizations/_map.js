define(function (require) {
  return function MapFactory(Private) {
    var _ = require('lodash');
    var $ = require('jquery');
    var L = require('leaflet');
    require('leaflet-draw');

    var defaultMapZoom = 2;
    var defaultMapCenter = [15, 5];
    var mapTiles = {
      url: 'https://otile{s}-s.mqcdn.com/tiles/1.0.0/map/{z}/{x}/{y}.jpeg',
      options: {
        attribution: 'Tiles by <a href="http://www.mapquest.com/">MapQuest</a> &mdash; ' +
          'Map data &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors, ' +
          '<a href="http://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA</a>',
        subdomains: '1234'
      }
    };
    var markerTypes = {
      'Scaled Circle Markers': Private(require('components/vislib/visualizations/marker_types/scaled_circles')),
      'Shaded Circle Markers': Private(require('components/vislib/visualizations/marker_types/shaded_circles')),
      'Shaded Geohash Grid': Private(require('components/vislib/visualizations/marker_types/geohash_grid')),
      'Heatmap': Private(require('components/vislib/visualizations/marker_types/heatmap')),
    };

    var defaultMarkerType = 'Scaled Circle Markers';

    /**
     * Tile Map Maps
     *
     * @class Map
     * @constructor
     * @param container {HTMLElement} HTML element to which the map will be appended
     * @param chartData {Object} Elasticsearch query results for this map
     * @param params {Object} Parameters used to build a map
     */
    function Map(container, chartData, params) {
      this._container = $(container).get(0);
      this._chartData = chartData;

      // keep a reference to all of the optional params
      this._events = _.get(params, 'events');
      this._markerType = markerTypes[params.markerType] ? params.markerType : defaultMarkerType;
      this._valueFormatter = params.valueFormatter || _.identity;
      this._tooltipFormatter = params.tooltipFormatter || _.identity;
      this._geoJson = _.get(this._chartData, 'geoJson');
      this._attr = params.attr || {};

      var mapOptions = {
        minZoom: 1,
        maxZoom: 18,
        noWrap: true,
        maxBounds: L.latLngBounds([-90, -220], [90, 220]),
        scrollWheelZoom: false,
        fadeAnimation: false,
      };

      this._createMap(mapOptions);
    }

    Map.prototype.addBoundingControl = function () {
      if (this._boundingControl) return;

      var self = this;
      var drawOptions = { draw: {} };

      _.each(['polyline', 'polygon', 'circle', 'marker', 'rectangle'], function (drawShape) {
        if (self._events && !self._events.listenerCount(drawShape)) {
          drawOptions.draw[drawShape] = false;
        } else {
          drawOptions.draw[drawShape] = {
            shapeOptions: {
              stroke: false,
              color: '#000'
            }
          };
        }
      });

      this._boundingControl = new L.Control.Draw(drawOptions);
      this.map.addControl(this._boundingControl);
    };

    Map.prototype.addFitControl = function () {
      if (this._fitControl) return;

      var self = this;
      var fitContainer = L.DomUtil.create('div', 'leaflet-control leaflet-bar leaflet-control-fit');

      // Add button to fit container to points
      var FitControl = L.Control.extend({
        options: {
          position: 'topleft'
        },
        onAdd: function (map) {
          $(fitContainer).html('<a class="fa fa-crop" href="#" title="Fit Data Bounds"></a>')
          .on('click', function (e) {
            e.preventDefault();
            self._fitBounds();
          });

          return fitContainer;
        },
        onRemove: function (map) {
          $(fitContainer).off('click');
        }
      });

      this._fitControl = new FitControl();
      // this._fitControl.addTo(this.map);
      this.map.addControl(this._fitControl);
    };

    /**
     * Adds label div to each map when data is split
     *
     * @method addTitle
     * @param mapLabel {String}
     * @return {undefined}
     */
    Map.prototype.addTitle = function (mapLabel) {
      if (this._label) return;

      var label = this._label = L.control();

      label.onAdd = function () {
        this._div = L.DomUtil.create('div', 'tilemap-info tilemap-label');
        this.update();
        return this._div;
      };
      label.update = function () {
        this._div.innerHTML = '<h2>' + _.escape(mapLabel) + '</h2>';
      };

      // label.addTo(this.map);
      this.map.addControl(label);
    };

    /**
     * remove css class for desat filters on map tiles
     *
     * @method saturateTiles
     * @return undefined
     */
    Map.prototype.saturateTiles = function () {
      if (!this._attr.isDesaturated) {
        $('img.leaflet-tile-loaded').addClass('filters-off');
      }
    };

    Map.prototype.updateSize = function () {
      this.map.invalidateSize({
        debounceMoveend: true
      });
    };

    Map.prototype.destroy = function () {
      if (this._label) this._label.removeFrom(this.map);
      if (this._fitControl) this._fitControl.removeFrom(this.map);
      if (this._boundingControl) this._boundingControl.removeFrom(this.map);
      if (this._markers) this._markers.destroy();
      this.map.remove();
      this.map = undefined;
    };

    /**
     * Switch type of data overlay for map:
     * creates featurelayer from mapData (geoJson)
     *
     * @method _addMarkers
     * @param map {Leaflet Object}
     * @param mapData {geoJson Object}
     * @return {Leaflet object} featureLayer
     */
    Map.prototype._addMarkers = function () {
      if (!this._geoJson) return;
      if (this._markers) this._markers.destroy();

      var MarkerType = markerTypes[this._markerType];
      this._markers = new MarkerType(this.map, this._geoJson, {
        tooltipFormatter: this._tooltipFormatter,
        valueFormatter: this._valueFormatter,
        attr: this._attr
      });

      if (this._geoJson.features.length > 1) {
        this._markers.addLegend();
      }
    };

    Map.prototype._attachEvents = function (map) {
      var self = this;
      var saturateTiles = self.saturateTiles.bind(self);

      this._tileLayer.on('tileload', saturateTiles);

      this.map.on('unload', function () {
        self._tileLayer.off('tileload', saturateTiles);
      });

      this.map.on('moveend', function setZoomCenter(ev) {
        // update internal center and zoom references
        self._mapCenter = self.map.getCenter();
        self._mapZoom = self.map.getZoom();

        if (self._events) {
          self._events.emit('mapMoveEnd', {
            chart: self._chartData,
            map: self.map,
            center: self._mapCenter,
            zoom: self._mapZoom,
          });
        }

        self._addMarkers();
      });

      this.map.on('draw:created', function (e) {
        var drawType = e.layerType;
        if (!self._events || !self._events.listenerCount(drawType)) return;

        // TODO: Different drawTypes need differ info. Need a switch on the object creation
        var bounds = e.layer.getBounds();

        if (self._events) {
          self._events.emit(drawType, {
            e: e,
            chart: self.originalConfig,
            bounds: {
              top_left: {
                lat: bounds.getNorthWest().lat,
                lon: bounds.getNorthWest().lng
              },
              bottom_right: {
                lat: bounds.getSouthEast().lat,
                lon: bounds.getSouthEast().lng
              }
            }
          });
        }
      });

      this.map.on('zoomend', function () {
        self._mapZoom = self.map.getZoom();

        if (self._events) {
          self._events.emit('mapZoomEnd', {
            chart: self._chartData,
            map: self.map,
            zoom: self._mapZoom,
          });
        }
      });
    };

    Map.prototype._createMap = function (mapOptions) {
      if (this.map) this.destroy();

      // get center and zoom from mapdata, or use defaults
      this._mapCenter = _.get(this._geoJson, 'properties.center') || defaultMapCenter;
      this._mapZoom = _.get(this._geoJson, 'properties.zoom') || defaultMapZoom;

      // add map tiles layer, using the mapTiles object settings
      this._tileLayer = L.tileLayer(mapTiles.url, mapTiles.options);

      // append tile layers, center and zoom to the map options
      mapOptions.layers = this._tileLayer;
      mapOptions.center = this._mapCenter;
      mapOptions.zoom = this._mapZoom;

      this.map = L.map(this._container, mapOptions);
      this._attachEvents();
      this._addMarkers();
    };

    /**
     * zoom map to fit all features in featureLayer
     *
     * @method _fitBounds
     * @param map {Leaflet Object}
     * @return {boolean}
     */
    Map.prototype._fitBounds = function () {
      this.map.fitBounds(this._getDataRectangles());
    };

    /**
     * Get the Rectangles representing the geohash grid
     *
     * @return {LatLngRectangles[]}
     */
    Map.prototype._getDataRectangles = function () {
      if (!this._geoJson) return [];

      return _(this._geoJson.features)
      .pluck('properties.rectangle')
      .invoke('map', function (rectangle) {
        // turn around the LngLat recieved from ES into LatLng for leaflet
        return rectangle.slice(0).reverse();
      })
      .value();
    };

    return Map;
  };
});
