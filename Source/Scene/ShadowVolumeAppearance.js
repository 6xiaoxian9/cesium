define([
        '../Core/Cartographic',
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Math',
        '../Core/Check',
        '../Core/ComponentDatatype',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/EncodedCartesian3',
        '../Core/GeometryInstanceAttribute',
        '../Core/Matrix2',
        '../Core/Matrix4',
        '../Core/Rectangle',
        '../Core/Transforms',
        '../Renderer/ShaderSource',
        '../Scene/PerInstanceColorAppearance',
        '../Shaders/ShadowVolumeAppearanceFS'
], function(
        Cartographic,
        Cartesian2,
        Cartesian3,
        CesiumMath,
        Check,
        ComponentDatatype,
        defaultValue,
        defined,
        defineProperties,
        EncodedCartesian3,
        GeometryInstanceAttribute,
        Matrix2,
        Matrix4,
        Rectangle,
        Transforms,
        ShaderSource,
        PerInstanceColorAppearance,
        ShadowVolumeAppearanceFS) {
    'use strict';

    /**
     * Creates shaders for a ClassificationPrimitive to use a given Appearance, as well as for picking.
     *
     * @param {Boolean} extentsCulling Discard fragments outside the instance's texture coordinate extents.
     * @param {Boolean} planarExtents If true, texture coordinates will be computed using planes instead of spherical coordinates.
     * @param {Appearance} appearance An Appearance to be used with a ClassificationPrimitive via GroundPrimitive.
     * @private
     */
    function ShadowVolumeAppearance(extentsCulling, planarExtents, appearance) {
        //>>includeStart('debug', pragmas.debug);
        Check.typeOf.bool('extentsCulling', extentsCulling);
        Check.typeOf.bool('planarExtents', planarExtents);
        Check.typeOf.object('appearance', appearance);
        //>>includeEnd('debug');

        // Compute shader dependencies
        var colorShaderDependencies = new ShaderDependencies();
        colorShaderDependencies.requiresTextureCoordinates = extentsCulling;
        colorShaderDependencies.requiresEC = !appearance.flat;

        var pickShaderDependencies = new ShaderDependencies();
        pickShaderDependencies.requiresTextureCoordinates = extentsCulling;

        if (appearance instanceof PerInstanceColorAppearance) {
            // PerInstanceColorAppearance doesn't have material.shaderSource, instead it has its own vertex and fragment shaders
            colorShaderDependencies.requiresNormalEC = !appearance.flat;
        } else {
            // Scan material source for what hookups are needed. Assume czm_materialInput materialInput.
            var materialShaderSource = appearance.material.shaderSource + '\n' + appearance.fragmentShaderSource;

            colorShaderDependencies.normalEC = materialShaderSource.indexOf('materialInput.normalEC') !== -1 || materialShaderSource.indexOf('czm_getDefaultMaterial') !== -1;
            colorShaderDependencies.positionToEyeEC = materialShaderSource.indexOf('materialInput.positionToEyeEC') !== -1;
            colorShaderDependencies.tangentToEyeMatrix = materialShaderSource.indexOf('materialInput.tangentToEyeMatrix') !== -1;
            colorShaderDependencies.st = materialShaderSource.indexOf('materialInput.st') !== -1;
        }

        this._colorShaderDependencies = colorShaderDependencies;
        this._pickShaderDependencies = pickShaderDependencies;
        this._appearance = appearance;
        this._extentsCulling = extentsCulling;
        this._planarExtents = planarExtents;
    }

    /**
     * Create the fragment shader for a ClassificationPrimitive's color pass when rendering for color.
     *
     * @param {Boolean} columbusView2D Whether the shader will be used for Columbus View or 2D.
     * @returns {ShaderSource} Shader source for the fragment shader.
     */
    ShadowVolumeAppearance.prototype.createFragmentShader = function(columbusView2D) {
        //>>includeStart('debug', pragmas.debug);
        Check.typeOf.bool('columbusView2D', columbusView2D);
        //>>includeEnd('debug');

        var appearance = this._appearance;
        var dependencies = this._colorShaderDependencies;

        var defines = [];
        if (!columbusView2D && !this._planarExtents) {
            defines.push('SPHERICAL');
        }
        if (dependencies.requiresEC) {
            defines.push('REQUIRES_EC');
        }
        if (dependencies.requiresWC) {
            defines.push('REQUIRES_WC');
        }
        if (dependencies.requiresTextureCoordinates) {
            defines.push('TEXTURE_COORDINATES');
        }
        if (this._extentsCulling) {
            defines.push('CULL_FRAGMENTS');
        }
        if (dependencies.requiresNormalEC) {
            defines.push('NORMAL_EC');
        }
        if (appearance instanceof PerInstanceColorAppearance) {
            defines.push('PER_INSTANCE_COLOR');
        }

        // Material inputs. Use of parameters in the material is different
        // from requirement of the parameters in the overall shader, for example,
        // texture coordinates may be used for fragment culling but not for the material itself.
        if (dependencies.normalEC) {
            defines.push('USES_NORMAL_EC');
        }
        if (dependencies.positionToEyeEC) {
            defines.push('USES_POSITION_TO_EYE_EC');
        }
        if (dependencies.tangentToEyeMatrix) {
            defines.push('USES_TANGENT_TO_EYE');
        }
        if (dependencies.st) {
            defines.push('USES_ST');
        }

        if (appearance.flat) {
            defines.push('FLAT');
        }

        var materialSource = '';
        if (!(appearance instanceof PerInstanceColorAppearance)) {
            materialSource = appearance.material.shaderSource;
        }

        return new ShaderSource({
            defines : defines,
            sources : [materialSource, ShadowVolumeAppearanceFS]
        });
    };

    ShadowVolumeAppearance.prototype.createPickFragmentShader = function(columbusView2D) {
        //>>includeStart('debug', pragmas.debug);
        Check.typeOf.bool('columbusView2D', columbusView2D);
        //>>includeEnd('debug');

        var dependencies = this._pickShaderDependencies;

        var defines = ['PICK'];
        if (!columbusView2D && !this._planarExtents) {
            defines.push('SPHERICAL');
        }
        if (dependencies.requiresEC) {
            defines.push('REQUIRES_EC');
        }
        if (dependencies.requiresWC) {
            defines.push('REQUIRES_WC');
        }
        if (dependencies.requiresTextureCoordinates) {
            defines.push('TEXTURE_COORDINATES');
        }
        if (this._extentsCulling) {
            defines.push('CULL_FRAGMENTS');
        }
        return new ShaderSource({
            defines : defines,
            sources : [ShadowVolumeAppearanceFS],
            pickColorQualifier : 'varying'
        });
    };

    /**
     * Create the vertex shader for a ClassificationPrimitive's color pass on the final of 3 shadow volume passes
     *
     * @param {String[]} defines External defines to pass to the vertex shader.
     * @param {String} vertexShaderSource ShadowVolumeAppearanceVS with any required modifications for computing position.
     * @param {Boolean} columbusView2D Whether the shader will be used for Columbus View or 2D.
     * @returns {String} Shader source for the vertex shader.
     */
    ShadowVolumeAppearance.prototype.createVertexShader = function(defines, vertexShaderSource, columbusView2D) {
        //>>includeStart('debug', pragmas.debug);
        Check.defined('defines', defines);
        Check.typeOf.string('vertexShaderSource', vertexShaderSource);
        Check.typeOf.bool('columbusView2D', columbusView2D);
        //>>includeEnd('debug');
        return createShadowVolumeAppearanceVS(this._colorShaderDependencies, this._planarExtents, columbusView2D, defines, vertexShaderSource, this._appearance);
    };

    /**
     * Create the vertex shader for a ClassificationPrimitive's pick pass on the final of 3 shadow volume passes
     *
     * @param {String[]} defines External defines to pass to the vertex shader.
     * @param {String} vertexShaderSource ShadowVolumeAppearanceVS with any required modifications for computing position and picking.
     * @param {Boolean} columbusView2D Whether the shader will be used for Columbus View or 2D.
     * @returns {String} Shader source for the vertex shader.
     */
    ShadowVolumeAppearance.prototype.createPickVertexShader = function(defines, vertexShaderSource, columbusView2D) {
        //>>includeStart('debug', pragmas.debug);
        Check.defined('defines', defines);
        Check.typeOf.string('vertexShaderSource', vertexShaderSource);
        Check.typeOf.bool('columbusView2D', columbusView2D);
        //>>includeEnd('debug');
        return createShadowVolumeAppearanceVS(this._pickShaderDependencies, this._planarExtents, columbusView2D, defines, vertexShaderSource);
    };

    function createShadowVolumeAppearanceVS(shaderDependencies, planarExtents, columbusView2D, defines, vertexShaderSource, appearance) {
        var allDefines = defines.slice();

        if (defined(appearance) && appearance instanceof PerInstanceColorAppearance) {
            allDefines.push('PER_INSTANCE_COLOR');
        }
        if (shaderDependencies.requiresTextureCoordinates) {
            allDefines.push('TEXTURE_COORDINATES');
            if (!(planarExtents || columbusView2D)) {
                allDefines.push('SPHERICAL');
            }
            if (columbusView2D) {
                allDefines.push('COLUMBUS_VIEW_2D');
            }
        }

        return new ShaderSource({
            defines : allDefines,
            sources : [vertexShaderSource]
        });
    }

    /**
     * Tracks shader dependencies.
     * @private
     */
    function ShaderDependencies() {
        this._requiresEC = false;
        this._requiresWC = false; // depends on eye coordinates, needed for material and for phong
        this._requiresNormalEC = false; // depends on eye coordinates, needed for material
        this._requiresTextureCoordinates = false; // depends on world coordinates, needed for material and for culling

        this._usesNormalEC = false;
        this._usesPositionToEyeEC = false;
        this._usesTangentToEyeMat = false;
        this._usesSt = false;
    }

    defineProperties(ShaderDependencies.prototype, {
        // Set when assessing final shading (flat vs. phong) and culling using computed texture coordinates
        requiresEC : {
            get : function() {
                return this._requiresEC;
            },
            set : function(value) {
                this._requiresEC = value || this._requiresEC;
            }
        },
        requiresWC : {
            get : function() {
                return this._requiresWC;
            },
            set : function(value) {
                this._requiresWC = value || this._requiresWC;
                this.requiresEC = this._requiresWC;
            }
        },
        requiresNormalEC : {
            get : function() {
                return this._requiresNormalEC;
            },
            set : function(value) {
                this._requiresNormalEC = value || this._requiresNormalEC;
                this.requiresEC = this._requiresNormalEC;
            }
        },
        requiresTextureCoordinates : {
            get : function() {
                return this._requiresTextureCoordinates;
            },
            set : function(value) {
                this._requiresTextureCoordinates = value || this._requiresTextureCoordinates;
                this.requiresWC = this._requiresTextureCoordinates;
            }
        },
        // Get/Set when assessing material hookups
        normalEC : {
            set : function(value) {
                this.requiresNormalEC = value;
                this._usesNormalEC = value;
            },
            get : function() {
                return this._usesNormalEC;
            }
        },
        tangentToEyeMatrix : {
            set : function(value) {
                this.requiresWC = value;
                this.requiresNormalEC = value;
                this._usesTangentToEyeMat = value;
            },
            get : function() {
                return this._usesTangentToEyeMat;
            }
        },
        positionToEyeEC : {
            set : function(value) {
                this.requiresEC = value;
                this._usesPositionToEyeEC = value;
            },
            get : function() {
                return this._usesPositionToEyeEC;
            }
        },
        st : {
            set : function(value) {
                this.requiresTextureCoordinates = value;
                this._usesSt = value;
            },
            get : function() {
                return this._usesSt;
            }
        }
    });

    function pointLineDistance(point1, point2, point) {
        return Math.abs((point2.y - point1.y) * point.x - (point2.x - point1.x) * point.y + point2.x * point1.y - point2.y * point1.x) / Cartesian2.distance(point2, point1);
    }

    var points2DScratch = [new Cartesian2(), new Cartesian2(), new Cartesian2(), new Cartesian2()];
    var rotatedPoint2DScratch = new Cartesian2();
    var rotation2DScratch = new Matrix2();
    var min2DScratch = new Cartesian2();
    var max2DScratch = new Cartesian2();
    var rectangleCenterScratch = new Cartographic();

    // boundingRectangle is a rectangle around the rotated geometry while geometryRectangle is the bounding box around the unrotated geometry.
    function addTextureCoordinateRotationAttributes(attributes, boundingRectangle, geometryRectangle, textureCoordinateRotation, geometryRotation) {
        textureCoordinateRotation = defaultValue(textureCoordinateRotation, 0.0);
        geometryRotation = defaultValue(geometryRotation, 0.0);

        var i;
        var point2D;

        // Assume a computed "east-north" texture coordinate system.
        // The "desired" texture coordinate system forms a rectangle around the geometryRectangle that completely bounds it.
        // Both the geometry and the "desired" texture coordinate system rectangles may be rotated.
        // Compute the corners of the "desired" texture coordinate system in "east-north" texture space by the following:
        // - Treat all rectangles as if the centers are at 0, 0
        // - rotate the geometryRectangle by geometryRotation - textureCoordinateRotation
        // - compute corners of box bounding transformed geometryRectangle. Call this "desired local"
        // - rotate 3 of the corners in "desired local" by textureCoordinateRotation, then compute the equivalent of
        //   each point in the "east-north" texture coordinate system.

        // Perform all computations in cartographic coordinates, no need to project.

        var northSouthHalfDistance = geometryRectangle.height * 0.5;
        var eastWestHalfDistance = geometryRectangle.width * 0.5;
        var boundingRectangleCenter = Rectangle.center(boundingRectangle, rectangleCenterScratch);

        var points2D = points2DScratch;
        points2D[0].x = eastWestHalfDistance;
        points2D[0].y = northSouthHalfDistance;

        points2D[1].x = -eastWestHalfDistance;
        points2D[1].y = northSouthHalfDistance;

        points2D[2].x = eastWestHalfDistance;
        points2D[2].y = -northSouthHalfDistance;

        points2D[3].x = -eastWestHalfDistance;
        points2D[3].y = -northSouthHalfDistance;

        var min2D = min2DScratch;
        min2D.x = Number.POSITIVE_INFINITY;
        min2D.y = Number.POSITIVE_INFINITY;
        var max2D = max2DScratch;
        max2D.x = Number.NEGATIVE_INFINITY;
        max2D.y = Number.NEGATIVE_INFINITY;

        var toDesiredLocal = Matrix2.fromRotation(geometryRotation - textureCoordinateRotation, rotation2DScratch);
        for (i = 0; i < 4; ++i) {
            point2D = Matrix2.multiplyByVector(toDesiredLocal, points2D[i], rotatedPoint2DScratch);
            Cartesian2.minimumByComponent(point2D, min2D, min2D);
            Cartesian2.maximumByComponent(point2D, max2D, max2D);
        }

        points2D[0].x = min2D.x;
        points2D[0].y = min2D.y;

        points2D[1].x = min2D.x;
        points2D[1].y = max2D.y;

        points2D[2].x = max2D.x;
        points2D[2].y = min2D.y;

        var toDesiredInComputed = Matrix2.fromRotation(textureCoordinateRotation, rotation2DScratch);
        northSouthHalfDistance = geometryRectangle.height * 0.5;
        eastWestHalfDistance = geometryRectangle.width * 0.5;

        for (i = 0; i < 3; ++i) {
            point2D = points2D[i];
            Matrix2.multiplyByVector(toDesiredInComputed, point2D, point2D);
            // Convert point into east-north texture coordinate space
            point2D.x = (point2D.x + boundingRectangleCenter.longitude - boundingRectangle.west) / boundingRectangle.width;
            point2D.y = (point2D.y + boundingRectangleCenter.latitude - boundingRectangle.south) / boundingRectangle.height;
        }

        // Encode these points in the batch table.
        // These will be used to create lines in east-north texture coordinate space.
        // Distance from an east-north texture coordinate to each line is a desired texture coordinate.
        var minXYCorner = points2D[0];
        var maxYCorner = points2D[1];
        var maxXCorner = points2D[2];
        attributes.uMaxVmax = new GeometryInstanceAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 4,
            normalize: false,
            value : [maxYCorner.x, maxYCorner.y, maxXCorner.x, maxXCorner.y]
        });

        var inverseExtentX = 1.0 / pointLineDistance(minXYCorner, maxYCorner, maxXCorner);
        var inverseExtentY = 1.0 / pointLineDistance(minXYCorner, maxXCorner, maxYCorner);

        attributes.uvMinAndExtents = new GeometryInstanceAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 4,
            normalize: false,
            value : [minXYCorner.x, minXYCorner.y, inverseExtentX, inverseExtentY]
        });
    }

    var cartographicScratch = new Cartographic();
    var cornerScratch = new Cartesian3();
    var northWestScratch = new Cartesian3();
    var southEastScratch = new Cartesian3();
    var highLowScratch = {high : 0.0, low : 0.0};
    function add2DTextureCoordinateAttributes(rectangle, projection, attributes) {
        // Compute corner positions in double precision
        var carto = cartographicScratch;
        carto.height = 0.0;

        carto.longitude = rectangle.west;
        carto.latitude = rectangle.south;

        var southWestCorner = projection.project(carto, cornerScratch);

        carto.latitude = rectangle.north;
        var northWest = projection.project(carto, northWestScratch);

        carto.longitude = rectangle.east;
        carto.latitude = rectangle.south;
        var southEast = projection.project(carto, southEastScratch);

        // Since these positions are all in the 2D plane, there's a lot of zeros
        // and a lot of repetition. So we only need to encode 4 values.
        // Encode:
        // x: x value for southWestCorner
        // y: y value for southWestCorner
        // z: y value for northWest
        // w: x value for southEast
        var valuesHigh = [0, 0, 0, 0];
        var valuesLow = [0, 0, 0, 0];
        var encoded = EncodedCartesian3.encode(southWestCorner.x, highLowScratch);
        valuesHigh[0] = encoded.high;
        valuesLow[0] = encoded.low;

        encoded = EncodedCartesian3.encode(southWestCorner.y, highLowScratch);
        valuesHigh[1] = encoded.high;
        valuesLow[1] = encoded.low;

        encoded = EncodedCartesian3.encode(northWest.y, highLowScratch);
        valuesHigh[2] = encoded.high;
        valuesLow[2] = encoded.low;

        encoded = EncodedCartesian3.encode(southEast.x, highLowScratch);
        valuesHigh[3] = encoded.high;
        valuesLow[3] = encoded.low;

        attributes.planes2D_HIGH = new GeometryInstanceAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 4,
            normalize: false,
            value : valuesHigh
        });

        attributes.planes2D_LOW = new GeometryInstanceAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 4,
            normalize: false,
            value : valuesLow
        });
    }

    var enuMatrixScratch = new Matrix4();
    var inverseEnuScratch = new Matrix4();
    var rectanglePointCartesianScratch = new Cartesian3();
    var pointsCartographicScratch = [
        new Cartographic(),
        new Cartographic(),
        new Cartographic(),
        new Cartographic(),
        new Cartographic(),
        new Cartographic(),
        new Cartographic(),
        new Cartographic()
    ];
    /**
     * When computing planes to bound the rectangle,
     * need to factor in "bulge" and other distortion.
     * Flatten the ellipsoid-centered corners and edge-centers of the rectangle
     * into the plane of the local ENU system, compute bounds in 2D, and
     * project back to ellipsoid-centered.
     */
    function computeRectangleBounds(rectangle, ellipsoid, height, southWestCornerResult, eastVectorResult, northVectorResult) {
        // Compute center of rectangle
        var centerCartographic = Rectangle.center(rectangle, rectangleCenterScratch);
        centerCartographic.height = height;
        var centerCartesian = Cartographic.toCartesian(centerCartographic, ellipsoid, rectanglePointCartesianScratch);
        var enuMatrix = Transforms.eastNorthUpToFixedFrame(centerCartesian, ellipsoid, enuMatrixScratch);
        var inverseEnu = Matrix4.inverse(enuMatrix, inverseEnuScratch);

        var west = rectangle.west;
        var east = rectangle.east;
        var north = rectangle.north;
        var south = rectangle.south;

        var cartographics = pointsCartographicScratch;
        cartographics[0].latitude = south;
        cartographics[0].longitude = west;
        cartographics[1].latitude = north;
        cartographics[1].longitude = west;
        cartographics[2].latitude = north;
        cartographics[2].longitude = east;
        cartographics[3].latitude = south;
        cartographics[3].longitude = east;

        var longitudeCenter = (west + east) * 0.5;
        var latitudeCenter = (north + south) * 0.5;

        cartographics[4].latitude = south;
        cartographics[4].longitude = longitudeCenter;
        cartographics[5].latitude = north;
        cartographics[5].longitude = longitudeCenter;
        cartographics[6].latitude = latitudeCenter;
        cartographics[6].longitude = west;
        cartographics[7].latitude = latitudeCenter;
        cartographics[7].longitude = east;

        var minX = Number.POSITIVE_INFINITY;
        var maxX = Number.NEGATIVE_INFINITY;
        var minY = Number.POSITIVE_INFINITY;
        var maxY = Number.NEGATIVE_INFINITY;
        for (var i = 0; i < 8; i++) {
            cartographics[i].height = height;
            var pointCartesian = Cartographic.toCartesian(cartographics[i], ellipsoid, rectanglePointCartesianScratch);
            Matrix4.multiplyByPoint(inverseEnu, pointCartesian, pointCartesian);
            pointCartesian.z = 0.0; // flatten into XY plane of ENU coordinate system
            minX = Math.min(minX, pointCartesian.x);
            maxX = Math.max(maxX, pointCartesian.x);
            minY = Math.min(minY, pointCartesian.y);
            maxY = Math.max(maxY, pointCartesian.y);
        }

        var southWestCorner = southWestCornerResult;
        southWestCorner.x = minX;
        southWestCorner.y = minY;
        southWestCorner.z = 0.0;
        Matrix4.multiplyByPoint(enuMatrix, southWestCorner, southWestCorner);

        var southEastCorner = eastVectorResult;
        southEastCorner.x = maxX;
        southEastCorner.y = minY;
        southEastCorner.z = 0.0;
        Matrix4.multiplyByPoint(enuMatrix, southEastCorner, southEastCorner);
        // make eastward vector
        Cartesian3.subtract(southEastCorner, southWestCorner, eastVectorResult);

        var northWestCorner = northVectorResult;
        northWestCorner.x = minX;
        northWestCorner.y = maxY;
        northWestCorner.z = 0.0;
        Matrix4.multiplyByPoint(enuMatrix, northWestCorner, northWestCorner);
        // make eastward vector
        Cartesian3.subtract(northWestCorner, southWestCorner, northVectorResult);
    }

    var eastwardScratch = new Cartesian3();
    var northwardScratch = new Cartesian3();
    var encodeScratch = new EncodedCartesian3();
    /**
     * Gets an attributes object containing:
     * - 3 high-precision points as 6 GeometryInstanceAttributes. These points are used to compute eye-space planes.
     * - 1 texture coordinate rotation GeometryInstanceAttributes
     * - 2 GeometryInstanceAttributes used to compute high-precision points in 2D and Columbus View.
     *   These points are used to compute eye-space planes like above.
     *
     * Used to compute texture coordinates for small-area ClassificationPrimitives with materials or multiple non-overlapping instances.
     *
     * @see ShadowVolumeAppearance
     * @private
     *
     * @param {Rectangle} boundingRectangle Rectangle object that the points will approximately bound
     * @param {Rectangle} geometryRectangle If the geometry can be rotated, the bounding rectangle for the unrotated geometry.
     * @param {Ellipsoid} ellipsoid Ellipsoid for converting Rectangle points to world coordinates
     * @param {MapProjection} projection The MapProjection used for 2D and Columbus View.
     * @param {Number} [height=0] The maximum height for the shadow volume.
     * @param {Number} [textureCoordinateRotation=0] Texture coordinate rotation
     * @param {Number} [geometryRotation] If the geometry can be rotated, the rotation in radians.
     * @returns {Object} An attributes dictionary containing planar texture coordinate attributes.
     */
    ShadowVolumeAppearance.getPlanarTextureCoordinateAttributes = function(boundingRectangle, geometryRectangle, ellipsoid, projection, height, textureCoordinateRotation, geometryRotation) {
        //>>includeStart('debug', pragmas.debug);
        Check.typeOf.object('boundingRectangle', boundingRectangle);
        Check.typeOf.object('geometryRectangle', geometryRectangle);
        Check.typeOf.object('ellipsoid', ellipsoid);
        Check.typeOf.object('projection', projection);
        //>>includeEnd('debug');

        var corner = cornerScratch;
        var eastward = eastwardScratch;
        var northward = northwardScratch;
        computeRectangleBounds(boundingRectangle, ellipsoid, defaultValue(height, 0.0), corner, eastward, northward);

        var attributes = {};
        addTextureCoordinateRotationAttributes(attributes, boundingRectangle, geometryRectangle, textureCoordinateRotation, geometryRotation);

        var encoded = EncodedCartesian3.fromCartesian(corner, encodeScratch);
        attributes.southWest_HIGH = new GeometryInstanceAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            normalize: false,
            value : Cartesian3.pack(encoded.high, [0, 0, 0])
        });
        attributes.southWest_LOW = new GeometryInstanceAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            normalize: false,
            value : Cartesian3.pack(encoded.low, [0, 0, 0])
        });
        attributes.eastward = new GeometryInstanceAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            normalize: false,
            value : Cartesian3.pack(eastward, [0, 0, 0])
        });
        attributes.northward = new GeometryInstanceAttribute({
            componentDatatype: ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            normalize: false,
            value : Cartesian3.pack(northward, [0, 0, 0])
        });

        add2DTextureCoordinateAttributes(boundingRectangle, projection, attributes);
        return attributes;
    };

    var spherePointScratch = new Cartesian3();
    function latLongToSpherical(latitude, longitude, ellipsoid, result) {
        var cartographic = cartographicScratch;
        cartographic.latitude = latitude;
        cartographic.longitude = longitude;
        cartographic.height = 0.0;

        var spherePoint = Cartographic.toCartesian(cartographic, ellipsoid, spherePointScratch);

        // Project into plane with vertical for latitude
        var magXY = Math.sqrt(spherePoint.x * spherePoint.x + spherePoint.y * spherePoint.y);

        // Use fastApproximateAtan2 for alignment with shader
        var sphereLatitude = CesiumMath.fastApproximateAtan2(magXY, spherePoint.z);
        var sphereLongitude = CesiumMath.fastApproximateAtan2(spherePoint.x, spherePoint.y);

        result.x = sphereLatitude;
        result.y = sphereLongitude;

        return result;
    }

    var sphericalScratch = new Cartesian2();
    /**
     * Gets an attributes object containing:
     * - the southwest corner of a rectangular area in spherical coordinates, as well as the inverse of the latitude/longitude range.
     *   These are computed using the same atan2 approximation used in the shader.
     * - 1 texture coordinate rotation GeometryInstanceAttributes
     * - 2 GeometryInstanceAttributes used to compute high-precision points in 2D and Columbus View.
     *   These points are used to compute eye-space planes like above.
     *
     * Used when computing texture coordinates for large-area ClassificationPrimitives with materials or
     * multiple non-overlapping instances.
     * @see ShadowVolumeAppearance
     * @private
     *
     * @param {Rectangle} boundingRectangle Rectangle object that the spherical extents will approximately bound
     * @param {Rectangle} geometryRectangle If the geometry can be rotated, the bounding rectangle for the unrotated geometry.
     * @param {Ellipsoid} ellipsoid Ellipsoid for converting Rectangle points to world coordinates
     * @param {MapProjection} projection The MapProjection used for 2D and Columbus View.
     * @param {Number} [textureCoordinateRotation=0] Texture coordinate rotation
     * @param {Number} [geometryRotation] If the geometry can be rotated, the rotation in radians.
     * @returns {Object} An attributes dictionary containing spherical texture coordinate attributes.
     */
    ShadowVolumeAppearance.getSphericalExtentGeometryInstanceAttributes = function(boundingRectangle, geometryRectangle, ellipsoid, projection, textureCoordinateRotation, geometryRotation) {
        //>>includeStart('debug', pragmas.debug);
        Check.typeOf.object('boundingRectangle', boundingRectangle);
        Check.typeOf.object('geometryRectangle', geometryRectangle);
        Check.typeOf.object('ellipsoid', ellipsoid);
        Check.typeOf.object('projection', projection);
        //>>includeEnd('debug');

        // rectangle cartographic coords !== spherical because it's on an ellipsoid
        var southWestExtents = latLongToSpherical(boundingRectangle.south, boundingRectangle.west, ellipsoid, sphericalScratch);

        // Slightly pad extents to avoid floating point error when fragment culling at edges.
        var south = southWestExtents.x - CesiumMath.EPSILON5;
        var west = southWestExtents.y - CesiumMath.EPSILON5;

        var northEastExtents = latLongToSpherical(boundingRectangle.north, boundingRectangle.east, ellipsoid, sphericalScratch);
        var north = northEastExtents.x + CesiumMath.EPSILON5;
        var east = northEastExtents.y + CesiumMath.EPSILON5;

        var longitudeRangeInverse = 1.0 / (east - west);
        var latitudeRangeInverse = 1.0 / (north - south);

        var attributes = {
            sphericalExtents : new GeometryInstanceAttribute({
                componentDatatype: ComponentDatatype.FLOAT,
                componentsPerAttribute: 4,
                normalize: false,
                value : [south, west, latitudeRangeInverse, longitudeRangeInverse]
            })
        };

        addTextureCoordinateRotationAttributes(attributes, boundingRectangle, geometryRectangle, textureCoordinateRotation, geometryRotation);
        add2DTextureCoordinateAttributes(boundingRectangle, projection, attributes);
        return attributes;
    };

    ShadowVolumeAppearance.hasAttributesForTextureCoordinatePlanes = function(attributes) {
        return defined(attributes.southWest_HIGH) && defined(attributes.southWest_LOW) &&
            defined(attributes.northward) && defined(attributes.eastward) &&
            defined(attributes.planes2D_HIGH) && defined(attributes.planes2D_LOW) &&
            defined(attributes.uMaxVmax) && defined(attributes.uvMinAndExtents);
    };

    ShadowVolumeAppearance.hasAttributesForSphericalExtents = function(attributes) {
        return defined(attributes.sphericalExtents) &&
        defined(attributes.planes2D_HIGH) && defined(attributes.planes2D_LOW) &&
        defined(attributes.uMaxVmax) && defined(attributes.uvMinAndExtents);
    };

    function shouldUseSpherical(rectangle) {
        return Math.max(rectangle.width, rectangle.height) > ShadowVolumeAppearance.MAX_WIDTH_FOR_PLANAR_EXTENTS;
    }

    /**
     * Computes whether the given rectangle is wide enough that texture coordinates
     * over its area should be computed using spherical extents instead of distance to planes.
     *
     * @param {Rectangle} rectangle A rectangle
     * @private
     */
    ShadowVolumeAppearance.shouldUseSphericalCoordinates = function(rectangle) {
        //>>includeStart('debug', pragmas.debug);
        Check.typeOf.object('rectangle', rectangle);
        //>>includeEnd('debug');

        return shouldUseSpherical(rectangle);
    };

    /**
     * Texture coordinates for ground primitives are computed either using spherical coordinates for large areas or
     * using distance from planes for small areas.
     *
     * @type {Number}
     * @constant
     * @private
     */
    ShadowVolumeAppearance.MAX_WIDTH_FOR_PLANAR_EXTENTS = CesiumMath.toRadians(1.0);

    return ShadowVolumeAppearance;
});
