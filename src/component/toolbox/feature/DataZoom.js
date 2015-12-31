define(function(require) {
    'use strict';

    var zrUtil = require('zrender/core/util');
    var numberUtil = require('../../../util/number');
    var SelectController = require('../../helper/SelectController');
    var BoundingRect = require('zrender/core/BoundingRect');
    var Group = require('zrender/container/Group');

    var each = zrUtil.each;
    var asc = numberUtil.asc;

    // Use dataZoomSelect
    require('../../dataZoomSelect');

    // Spectial component id start with \0ec\0, see echarts/model/Global.js~hasInnerId
    var DATA_ZOOM_ID_BASE = '\0_ec_\0toolbox-dataZoom_';

    function DataZoom(model) {
        this.model = model;

        /**
         * @private
         * @type {module:zrender/container/Group}
         */
        this._controllerGroup;

        /**
         * @private
         * @type {module:echarts/component/helper/SelectController}
         */
        this._controller;

        /**
         * Is button active.
         * @private
         * @type {Object}
         */
        this._selectedMap = {zoom: false, back: false};

        /**
         * [{key: dataZoomId, value: {dataZoomId, range}}, ...]
         * History length of each dataZoom may be different.
         * this._history[0] is used to store origin range.
         * @private
         * @type {Array.<Object>}
         */
        this._history = [{}];
    }

    DataZoom.defaultOption = {
        show: false,
        type: [],
        // Icon group
        icon: {
            zoom: 'M0,13.5h26.9 M13.5,26.9V0 M32.1,13.5H58V58H13.5 V32.1',
            back: 'M22,1.4L9.9,13.5l12.3,12.3 M10.3,13.5H54.9v44.6 H10.3v-26'
        },
        title: {
            zoom: '区域缩放',
            back: '区域缩放还原'
        },
        seriesIndex: {}
    };

    var proto = DataZoom.prototype;

    proto.onclick = function (ecModel, api, type) {
        var controllerGroup = this._controllerGroup;
        if (!this._controllerGroup) {
            controllerGroup = this._controllerGroup = new Group();
            api.getZr().add(controllerGroup);
        }

        handlers[type].call(this, controllerGroup, ecModel, api);
    };

    proto.remove = function () {
        this._disposeController();
        this._history = {};
    };

    proto.dispose = function (ecModel, api) {
        this._disposeController();
        this._history = {};
        this._controllerGroup && api.getZr().remove(this._controllerGroup);
    };

    /**
     * @private
     */
    var handlers = {

        zoom: function (controllerGroup, ecModel, api) {
            var isZoomActive = this._selectedMap.zoom = !this._selectedMap.zoom;
            var zr = api.getZr();

            if (isZoomActive) {
                zr.setDefaultCursorStyle('crosshair');

                // FIXME
                // polar

                var coordInfoList = [];
                ecModel.eachComponent('grid', function (gridModel, gridIndex) {
                    var grid = gridModel.coordinateSystem;
                    coordInfoList.push(prepareCoordInfo(grid, ecModel));
                }, this);

                this._createController(controllerGroup, coordInfoList, ecModel, api);
            }
            else {
                zr.setDefaultCursorStyle('default');
                this._disposeController();
            }
        },

        back: function (controllerGroup, ecModel, api) {
            this._dispatchAction(this._popHistory(), api);
        }
    };

    proto.getSelectedMap = function () {
        return zrUtil.clone(this._selectedMap);
    };

    /**
     * @private
     */
    proto._createController = function (controllerGroup, coordInfoList, ecModel, api) {
        var controller = this._controller = new SelectController(
            'rect',
            api.getZr(),
            {
                // FIXME
                lineWidth: 3,
                stroke: '#333',
                fill: 'rgba(0,0,0,0.5)'
            }
        );
        controller.on(
            'selectEnd',
            zrUtil.bind(this._onSelected, this, controller, coordInfoList, ecModel, api)
        );
        controller.enable(controllerGroup, false);
    };

    proto._disposeController = function () {
        var controller = this._controller;
        if (controller) {
            controller.off('selected');
            controller.dispose();
        }
    };

    function prepareCoordInfo(grid, ecModel) {
        // Default use the first axis.
        // FIXME
        var coordInfo = [
            {axisModel: grid.getAxis('x').model, axisIndex: 0}, // x
            {axisModel: grid.getAxis('y').model, axisIndex: 0}  // y
        ];
        coordInfo.grid = grid;

        ecModel.eachComponent(
            {mainType: 'dataZoom', subType: 'select'},
            function (dzModel, dataZoomIndex) {
                if (isTheAxis('xAxis', coordInfo[0].axisModel, dzModel, ecModel)) {
                    coordInfo[0].dataZoomModel = dzModel;
                }
                if (isTheAxis('yAxis', coordInfo[1].axisModel, dzModel, ecModel)) {
                    coordInfo[1].dataZoomModel = dzModel;
                }
            }
        );

        return coordInfo;
    }

    function isTheAxis(axisName, axisModel, dataZoomModel, ecModel) {
        var axisIndex = dataZoomModel.get(axisName + 'Index');
        return axisIndex != null
            && ecModel.getComponent(axisName, axisIndex) === axisModel;
    }

    /**
     * @private
     */
    proto._onSelected = function (controller, coordInfoList, ecModel, api, selRanges) {
        if (!selRanges.length) {
            return;
        }
        var selRange = selRanges[0];

        controller.update(); // remove cover

        var snapshot = {};

        each(coordInfoList, function (coordInfo) {
            var selDataRange = pointToDataInCartesian(selRange, coordInfo);

            if (selDataRange) {
                var xBatchItem = scaleCartesianAxis(selDataRange, coordInfo, 0, 'x');
                var yBatchItem = scaleCartesianAxis(selDataRange, coordInfo, 1, 'y');

                xBatchItem && (snapshot[xBatchItem.dataZoomId] = xBatchItem);
                yBatchItem && (snapshot[yBatchItem.dataZoomId] = yBatchItem);
            }
        });

        this._pushHistory(snapshot, ecModel);
        this._dispatchAction(snapshot, api);
    };

    function pointToDataInCartesian(selRange, coordInfo) {
        var grid = coordInfo.grid;

        var selRect = new BoundingRect(
            selRange[0][0],
            selRange[1][0],
            selRange[0][1] - selRange[0][0],
            selRange[1][1] - selRange[1][0]
        );
        if (!selRect.intersect(grid.getRect())) {
            return;
        }

        var cartesian = grid.getCartesian(coordInfo[0].axisIndex, coordInfo[1].axisIndex);
        var dataLeftTop = cartesian.pointToData([selRange[0][0], selRange[1][0]], true);
        var dataRightBottom = cartesian.pointToData([selRange[0][1], selRange[1][1]], true);

        return [
            asc([dataLeftTop[0], dataRightBottom[0]]), // x, using asc to handle inverse
            asc([dataLeftTop[1], dataRightBottom[1]]) // y, using asc to handle inverse
        ];
    }

    function scaleCartesianAxis(selDataRange, coordInfo, dimIdx, dimName) {
        var dimCoordInfo = coordInfo[dimIdx];
        var dataZoomModel = dimCoordInfo.dataZoomModel;

        return {
            dataZoomId: dataZoomModel.id,
            startValue: selDataRange[dimIdx][0],
            endValue: selDataRange[dimIdx][1]
        };
    }

    /**
     * @private
     */
    proto._dispatchAction = function (snapshot, api) {
        var batch = [];

        each(snapshot, function (batchItem) {
            batch.push(batchItem);
        });

        batch.length && api.dispatchAction({
            type: 'dataZoom',
            from: this.uid,
            batch: zrUtil.clone(batch, true)
        });
    };

    /**
     * @private
     */
    proto._pushHistory = function (newSnapshot, ecModel) {
        var history = this._history;

        // If previous dataZoom can not be found,
        // complete an range with current range.
        each(newSnapshot, function (batchItem, dataZoomId) {
            var i = history.length - 1;
            for (; i >= 0; i--) {
                var snapshot = history[i];
                if (snapshot[dataZoomId]) {
                    break;
                }
            }
            if (i < 0) {
                // No origin range set, create one by current range.
                var dataZoomModel = ecModel.queryComponents(
                    {mainType: 'dataZoom', subType: 'select', id: dataZoomId}
                )[0];
                if (dataZoomModel) {
                    var percentRange = dataZoomModel.getPercentRange();
                    history[0][dataZoomId] = {
                        dataZoomId: dataZoomId,
                        start: percentRange[0],
                        end: percentRange[1]
                    };
                }
            }
        });

        history.push(newSnapshot);

        // Update state of back button.
        this._selectedMap.back = history.length <= 1;
    };

    /**
     * @private
     */
    proto._popHistory = function () {
        var history = this._history;
        var head = history[history.length - 1];
        history.length > 1 && history.pop();

        // Update state of back button.
        this._selectedMap.back = history.length <= 1;

        // Find top for all dataZoom.
        var snapshot = {};
        each(head, function (batchItem, dataZoomId) {
            for (var i = history.length - 1; i >= 0; i--) {
                var batchItem = history[i][dataZoomId];
                if (batchItem) {
                    snapshot[dataZoomId] = batchItem;
                    break;
                }
            }
        });

        return snapshot;
    };



    require('../featureManager').register('dataZoom', DataZoom);



    // Create special dataZoom option for select
    require('../../../echarts').registerPreprocessor(function (option) {
        if (!option) {
            return;
        }

        var dataZoomOpts = option.dataZoom || (option.dataZoom = []);
        if (!zrUtil.isArray(dataZoomOpts)) {
            dataZoomOpts = [dataZoomOpts];
        }

        // TODO
        // polar

        addForAxis('xAxis');
        addForAxis('yAxis');

        function addForAxis(axisName) {
            forEachComponent(axisName, function (axisOpt, axisIndex) {
                var newOpt = {
                    type: 'select',
                    // Id for merge mapping.
                    id: DATA_ZOOM_ID_BASE + axisName + axisIndex
                };
                // FIXME
                // Only support one axis now.
                newOpt[axisName + 'Index'] = axisIndex;
                dataZoomOpts.push(newOpt);
            });
        }

        function forEachComponent(mainType, cb) {
            var opts = option[mainType];
            if (!zrUtil.isArray(opts)) {
                opts = opts ? [opts] : [];
            }
            each(opts, cb);
        }
    });

    return DataZoom;
});