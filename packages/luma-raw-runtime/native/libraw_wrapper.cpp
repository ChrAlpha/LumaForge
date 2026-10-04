#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <libraw/libraw.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using emscripten::class_;
using emscripten::typed_memory_view;
using emscripten::val;

struct OutputSize {
  int width;
  int height;
};

struct WindowRect {
  int x;
  int y;
  int width;
  int height;
};

struct WindowHalo {
  int left;
  int top;
  int right;
  int bottom;
};

std::string librawError(const std::string &operation, int code) {
  return operation + " failed: " + LibRaw::strerror(code);
}

void requireLibRawSuccess(const std::string &operation, int code) {
  if (code != LIBRAW_SUCCESS) {
    throw std::runtime_error(librawError(operation, code));
  }
}

std::string thumbnailFormat(enum LibRaw_thumbnail_formats format) {
  switch (format) {
    case LIBRAW_THUMBNAIL_JPEG:
      return "jpeg";
    case LIBRAW_THUMBNAIL_BITMAP:
    case LIBRAW_THUMBNAIL_BITMAP16:
      return "bitmap";
    default:
      return "unknown";
  }
}

std::string processedImageFormat(enum LibRaw_image_formats format) {
  switch (format) {
    case LIBRAW_IMAGE_JPEG:
      return "jpeg";
    case LIBRAW_IMAGE_BITMAP:
      return "bitmap";
    default:
      return "unknown";
  }
}

bool isUnavailableThumbnailError(int code) {
  return code == LIBRAW_NO_THUMBNAIL ||
         code == LIBRAW_UNSUPPORTED_THUMBNAIL ||
         code == LIBRAW_REQUEST_FOR_NONEXISTENT_THUMBNAIL;
}

double nowMs() { return emscripten_get_now(); }

val timingObject(double setup, double open, double unpack, double process,
                 double output_copy, double orientation, double total) {
  val timings = val::object();
  timings.set("setup", setup);
  timings.set("open", open);
  timings.set("unpack", unpack);
  timings.set("process", process);
  timings.set("outputCopy", output_copy);
  timings.set("orientation", orientation);
  timings.set("total", total);
  return timings;
}

std::string safeString(const char *value) {
  return value == nullptr ? std::string() : std::string(value);
}

std::vector<unsigned char> copyInputBytes(val data) {
  const val Uint8Array = val::global("Uint8Array");
  const val ArrayBuffer = val::global("ArrayBuffer");

  val u8 = data.instanceof(Uint8Array)
               ? data
               : (data.instanceof(ArrayBuffer)
                      ? Uint8Array.new_(data)
                      : Uint8Array.new_(data["buffer"], data["byteOffset"],
                                        data["byteLength"]));

  const size_t length = u8["byteLength"].as<size_t>();
  std::vector<unsigned char> out(length);
  if (out.empty()) {
    return out;
  }

  val wasmView = val(typed_memory_view(out.size(), out.data()));
  wasmView.call<void>("set", u8);
  return out;
}

val copiedUint8Array(const unsigned char *data, size_t size) {
  return val::global("Uint8Array").new_(typed_memory_view(size, data));
}

val copiedUint16Array(const uint16_t *data, size_t size) {
  return val::global("Uint16Array").new_(typed_memory_view(size, data));
}

size_t checkedMultiply(size_t left, size_t right, const std::string &label) {
  if (left != 0 && right > std::numeric_limits<size_t>::max() / left) {
    throw std::runtime_error(label + " exceeds native addressable memory.");
  }

  return left * right;
}

int normalizedCfaColor(LibRaw &processor, int row, int col) {
  const int color_index = processor.COLOR(row, col);
  if (color_index < 0 || color_index >= 6) {
    return -1;
  }

  switch (processor.imgdata.idata.cdesc[color_index]) {
    case 'R':
    case 'r':
      return 0;
    case 'G':
    case 'g':
      return 1;
    case 'B':
    case 'b':
      return 2;
    default:
      if (color_index == 3 && processor.imgdata.idata.colors <= 3) {
        return 1;
      }
      return -1;
  }
}

int normalizedFilterColor(const libraw_data_t &imgdata, int row, int col) {
  if (imgdata.idata.filters < 1000) {
    return -1;
  }

  const int color_index =
      (imgdata.idata.filters >> ((((row << 1) & 14) | (col & 1)) << 1)) & 3;
  if (color_index == 3 && imgdata.idata.colors <= 3) {
    return 1;
  }

  switch (imgdata.idata.cdesc[color_index]) {
    case 'R':
    case 'r':
      return 0;
    case 'G':
    case 'g':
      return 1;
    case 'B':
    case 'b':
      return 2;
    default:
      return -1;
  }
}

std::string cfaPatternFromColors(int top_left, int top_right, int bottom_left,
                                 int bottom_right) {
  if (top_left == 0 && top_right == 1 && bottom_left == 1 &&
      bottom_right == 2) {
    return "rggb";
  }
  if (top_left == 2 && top_right == 1 && bottom_left == 1 &&
      bottom_right == 0) {
    return "bggr";
  }
  if (top_left == 1 && top_right == 0 && bottom_left == 2 &&
      bottom_right == 1) {
    return "grbg";
  }
  if (top_left == 1 && top_right == 2 && bottom_left == 0 &&
      bottom_right == 1) {
    return "gbrg";
  }

  return "unsupported";
}

std::string cfaPatternName(LibRaw &processor) {
  const int top_left = normalizedCfaColor(processor, 0, 0);
  const int top_right = normalizedCfaColor(processor, 0, 1);
  const int bottom_left = normalizedCfaColor(processor, 1, 0);
  const int bottom_right = normalizedCfaColor(processor, 1, 1);
  const std::string color_pattern =
      cfaPatternFromColors(top_left, top_right, bottom_left, bottom_right);

  if (color_pattern != "unsupported") {
    return color_pattern;
  }

  const libraw_data_t &imgdata = processor.imgdata;
  return cfaPatternFromColors(normalizedFilterColor(imgdata, 0, 0),
                              normalizedFilterColor(imgdata, 0, 1),
                              normalizedFilterColor(imgdata, 1, 0),
                              normalizedFilterColor(imgdata, 1, 1));
}

bool hasBayerRawImage(const libraw_data_t &imgdata) {
  return imgdata.rawdata.raw_image != nullptr && imgdata.idata.filters != 0;
}

bool hasColor3Image(const libraw_data_t &imgdata) {
  return imgdata.rawdata.color3_image != nullptr;
}

bool hasColor4Image(const libraw_data_t &imgdata) {
  return imgdata.rawdata.color4_image != nullptr;
}

bool hasXTransTable(const libraw_data_t &imgdata) {
  for (int row = 0; row < 6; ++row) {
    for (int col = 0; col < 6; ++col) {
      if (imgdata.idata.xtrans[row][col] != 0 ||
          imgdata.idata.xtrans_abs[row][col] != 0) {
        return true;
      }
    }
  }

  return false;
}

std::string sensorLayoutName(const libraw_data_t &imgdata) {
  if (imgdata.idata.is_foveon != 0) {
    return "foveon";
  }
  if (hasXTransTable(imgdata)) {
    return "x-trans";
  }
  if (hasBayerRawImage(imgdata)) {
    return "bayer";
  }
  if (hasColor3Image(imgdata) || hasColor4Image(imgdata)) {
    return "rgb-like";
  }
  if (imgdata.idata.colors == 1) {
    return "monochrome";
  }

  return "unknown";
}

val cfaObject(const std::string &pattern) {
  val cfa = val::object();
  cfa.set("pattern", pattern);
  cfa.set("xPhase", 0);
  cfa.set("yPhase", 0);
  return cfa;
}

val visibleCropObject(int x, int y, int width, int height) {
  val crop = val::object();
  crop.set("x", x);
  crop.set("y", y);
  crop.set("width", width);
  crop.set("height", height);
  return crop;
}

val sensorLayoutObject(const libraw_data_t &imgdata,
                       const std::string &pattern) {
  val sensor = val::object();
  sensor.set("layout", sensorLayoutName(imgdata));
  sensor.set("colorCount", imgdata.idata.colors > 0 ? imgdata.idata.colors : 3);
  sensor.set("cfa", cfaObject(pattern));
  sensor.set("phaseIsWindowLocal", false);
  return sensor;
}

val levelsObject(const libraw_colordata_t &color) {
  val per_channel_black = val::array();
  for (int index = 0; index < 4; ++index) {
    per_channel_black.set(index, color.cblack[index]);
  }

  val levels = val::object();
  levels.set("black", color.black);
  levels.set("white", color.maximum);
  levels.set("perChannelBlack", per_channel_black);
  return levels;
}

bool hasPositiveImageDimensions(const libraw_image_sizes_t &sizes) {
  return sizes.width > 0 && sizes.height > 0 && sizes.raw_width > 0 &&
         sizes.raw_height > 0;
}

bool hasValidLevels(const libraw_colordata_t &color) {
  return color.maximum > color.black;
}

bool hasVisibleCropWithinRaw(const libraw_image_sizes_t &sizes) {
  return hasPositiveImageDimensions(sizes) &&
         sizes.left_margin <= sizes.raw_width - sizes.width &&
         sizes.top_margin <= sizes.raw_height - sizes.height;
}

bool usesFixedExportPolicy(const libraw_output_params_t &params) {
  return params.output_color == 4 && params.output_bps == 16 &&
         params.no_auto_bright == 1 && params.use_auto_wb == 0 &&
         params.use_camera_wb == 1 && params.use_camera_matrix == 1 &&
         params.bright == 1 && params.highlight == 2 && params.user_qual >= 0 &&
         params.gamm[0] == 1 && params.gamm[1] == 1 && params.gamm[2] == 1 &&
         params.gamm[3] == 1 && params.gamm[4] == 0 && params.gamm[5] == 0;
}

int normalizedOrientationCode(int code) {
  return code == 0 ? 1 : code;
}

bool orientationSwapsAxes(int code) {
  const int normalized_code = normalizedOrientationCode(code);
  return normalized_code == 5 || normalized_code == 6 ||
         normalized_code == 8;
}

bool supportsProcessedWindowOrientation(int code) {
  switch (normalizedOrientationCode(code)) {
    case 1:
    case 3:
    case 5:
    case 6:
    case 8:
      return true;
    default:
      return false;
  }
}

int processedOutputWidth(const libraw_image_sizes_t &sizes) {
  return orientationSwapsAxes(sizes.flip) ? sizes.height : sizes.width;
}

int processedOutputHeight(const libraw_image_sizes_t &sizes) {
  return orientationSwapsAxes(sizes.flip) ? sizes.width : sizes.height;
}

bool supportsRepeatableCropProcess(const libraw_data_t &imgdata) {
  return hasPositiveImageDimensions(imgdata.sizes) &&
         hasValidLevels(imgdata.color) && hasVisibleCropWithinRaw(imgdata.sizes) &&
         sensorLayoutName(imgdata) != "unknown";
}

bool supportsProcessedWindow(const libraw_data_t &imgdata) {
  return supportsRepeatableCropProcess(imgdata) &&
         supportsProcessedWindowOrientation(imgdata.sizes.flip) &&
         usesFixedExportPolicy(imgdata.params);
}

val windowsObject(const libraw_data_t &imgdata) {
  val windows = val::object();
  windows.set("librawProcessed", supportsProcessedWindow(imgdata));
  windows.set("rawMosaic", hasBayerRawImage(imgdata));
  return windows;
}

val diagnosticsObject(const libraw_data_t &imgdata) {
  val diagnostics = val::object();
  diagnostics.set("make", safeString(imgdata.idata.make));
  diagnostics.set("model", safeString(imgdata.idata.model));
  diagnostics.set("normalizedMake", safeString(imgdata.idata.normalized_make));
  diagnostics.set("normalizedModel",
                  safeString(imgdata.idata.normalized_model));
  diagnostics.set("librawFilterCode", imgdata.idata.filters);
  diagnostics.set("hasRawImage", imgdata.rawdata.raw_image != nullptr);
  diagnostics.set("hasColor3Image", hasColor3Image(imgdata));
  diagnostics.set("hasColor4Image", hasColor4Image(imgdata));
  diagnostics.set("hasXTransTable", hasXTransTable(imgdata));
  diagnostics.set("canRepeatCropProcess", supportsRepeatableCropProcess(imgdata));
  diagnostics.set("lastLibRawWarningMask", imgdata.process_warnings);
  return diagnostics;
}

val orientationObject(const libraw_image_sizes_t &sizes) {
  const int normalized_code = normalizedOrientationCode(sizes.flip);

  val orientation = val::object();
  orientation.set("code", normalized_code);
  orientation.set("supported",
                  supportsProcessedWindowOrientation(normalized_code));
  orientation.set("outputWidth", processedOutputWidth(sizes));
  orientation.set("outputHeight", processedOutputHeight(sizes));
  return orientation;
}

int requiredIntegerProperty(val object, const char *property,
                            const std::string &label) {
  if (object.isNull() || object.isUndefined() ||
      !object.hasOwnProperty(property)) {
    throw std::runtime_error(label + " is required.");
  }

  const double value = object[property].as<double>();
  if (!std::isfinite(value) || std::floor(value) != value ||
      value < std::numeric_limits<int>::min() ||
      value > std::numeric_limits<int>::max()) {
    throw std::runtime_error(label + " must be an integer.");
  }

  return static_cast<int>(value);
}

WindowRect parseOutputRect(val request) {
  if (request.isNull() || request.isUndefined() ||
      !request.hasOwnProperty("outputRect")) {
    throw std::runtime_error("Processed window outputRect is required.");
  }

  const val rect = request["outputRect"];
  WindowRect parsed = {
      requiredIntegerProperty(rect, "x", "Processed window outputRect.x"),
      requiredIntegerProperty(rect, "y", "Processed window outputRect.y"),
      requiredIntegerProperty(rect, "width",
                              "Processed window outputRect.width"),
      requiredIntegerProperty(rect, "height",
                              "Processed window outputRect.height"),
  };

  if (parsed.x < 0 || parsed.y < 0 || parsed.width <= 0 ||
      parsed.height <= 0) {
    throw std::runtime_error(
        "Processed window outputRect must be non-negative with positive "
        "dimensions.");
  }

  return parsed;
}

WindowHalo parseWindowHalo(val request) {
  if (request.isNull() || request.isUndefined() ||
      !request.hasOwnProperty("halo")) {
    throw std::runtime_error("Processed window halo is required.");
  }

  const val halo = request["halo"];
  WindowHalo parsed = {
      requiredIntegerProperty(halo, "left", "Processed window halo.left"),
      requiredIntegerProperty(halo, "top", "Processed window halo.top"),
      requiredIntegerProperty(halo, "right", "Processed window halo.right"),
      requiredIntegerProperty(halo, "bottom", "Processed window halo.bottom"),
  };

  if (parsed.left < 0 || parsed.top < 0 || parsed.right < 0 ||
      parsed.bottom < 0) {
    throw std::runtime_error("Processed window halo must be non-negative.");
  }

  return parsed;
}

WindowRect expandOutputRect(const WindowRect &rect, const WindowHalo &halo,
                            int output_width, int output_height) {
  if (output_width <= 0 || output_height <= 0 || rect.x > output_width - rect.width ||
      rect.y > output_height - rect.height) {
    throw std::runtime_error(
        "Processed window outputRect is outside output bounds.");
  }

  const int x0 = std::max(0, rect.x - halo.left);
  const int y0 = std::max(0, rect.y - halo.top);
  const int x1 =
      std::min(output_width, rect.x + rect.width + halo.right);
  const int y1 =
      std::min(output_height, rect.y + rect.height + halo.bottom);

  return {x0, y0, x1 - x0, y1 - y0};
}

WindowRect sourceCropForOutputRect(const WindowRect &output_rect,
                                   int source_width, int source_height,
                                   int orientation) {
  const int x0 = output_rect.x;
  const int y0 = output_rect.y;
  const int x1 = output_rect.x + output_rect.width;
  const int y1 = output_rect.y + output_rect.height;

  switch (normalizedOrientationCode(orientation)) {
    case 1:
      return {x0, y0, output_rect.width, output_rect.height};
    case 3:
      return {source_width - x1, source_height - y1, output_rect.width,
              output_rect.height};
    case 5:
    case 8:
      return {source_width - y1, x0, output_rect.height, output_rect.width};
    case 6:
      return {y0, source_height - x1, output_rect.height, output_rect.width};
    default:
      throw std::runtime_error(
          "LibRaw processed-window orientation is unsupported.");
  }
}

void applyStrictExportProcessingSettings(libraw_output_params_t &params) {
  params.half_size = 0;
  params.use_camera_wb = 1;
  params.use_auto_wb = 0;
  params.output_color = 4;
  params.output_bps = 16;
  params.no_auto_bright = 1;
  params.use_camera_matrix = 1;
  params.bright = 1;
  params.highlight = 2;
  params.user_qual = 0;
  params.user_flip = 0;
  params.gamm[0] = 1;
  params.gamm[1] = 1;
  params.gamm[2] = 1;
  params.gamm[3] = 1;
  params.gamm[4] = 0;
  params.gamm[5] = 0;
}

val rectObject(const WindowRect &rect) {
  val out_rect = val::object();
  out_rect.set("x", rect.x);
  out_rect.set("y", rect.y);
  out_rect.set("width", rect.width);
  out_rect.set("height", rect.height);
  return out_rect;
}

val numberArray(const double *values, int length) {
  val array = val::array();
  for (int index = 0; index < length; ++index) {
    array.set(index, values[index]);
  }
  return array;
}

double determinant3x3(const double *m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) -
         m[1] * (m[3] * m[8] - m[5] * m[6]) +
         m[2] * (m[3] * m[7] - m[4] * m[6]);
}

bool isFiniteMatrix3x3(const double *m) {
  for (int index = 0; index < 9; ++index) {
    if (!std::isfinite(m[index])) {
      return false;
    }
  }
  return std::abs(determinant3x3(m)) > 1e-12;
}

bool selectCameraWhiteBalance(const libraw_colordata_t &color,
                              double *white_balance) {
  const float *source = color.cam_mul;
  double raw_multipliers[4] = {0, 0, 0, 0};
  double min_multiplier = 0.0;
  double max_multiplier = 0.0;

  for (int index = 0; index < 4; ++index) {
    if (!std::isfinite(source[index]) || source[index] <= 0) {
      return false;
    }

    raw_multipliers[index] = source[index];
    if (index == 0) {
      min_multiplier = raw_multipliers[index];
      max_multiplier = raw_multipliers[index];
    } else {
      min_multiplier = std::min(min_multiplier, raw_multipliers[index]);
      max_multiplier = std::max(max_multiplier, raw_multipliers[index]);
    }
  }

  if (max_multiplier <= min_multiplier) {
    return false;
  }

  // LibRaw cam_mul is a camera-scale fact, while raw-window export applies
  // white balance to normalized scene-linear samples. Green-normalize to match
  // the native preview intent: remove camera units while preserving camera WB
  // chromatic ratios relative to the demosaiced green channel.
  const double normalization_scale = raw_multipliers[1];

  for (int index = 0; index < 4; ++index) {
    white_balance[index] = raw_multipliers[index] / normalization_scale;
    if (!std::isfinite(white_balance[index]) || white_balance[index] <= 0) {
      return false;
    }
  }

  return true;
}

bool buildCameraToWorkingRgb(const libraw_colordata_t &color,
                             double *camera_to_working_rgb) {
  double camera_to_srgb[9] = {
      color.rgb_cam[0][0], color.rgb_cam[0][1], color.rgb_cam[0][2],
      color.rgb_cam[1][0], color.rgb_cam[1][1], color.rgb_cam[1][2],
      color.rgb_cam[2][0], color.rgb_cam[2][1], color.rgb_cam[2][2],
  };

  // Row-major linear sRGB D65 -> linear ProPhoto RGB D50. This is the inverse
  // of the app's ProPhoto -> sRGB matrix generated by src/lib/color/matrix.ts.
  // LibRaw rgb_cam is camera -> sRGB, so the exported working transform is:
  // camera -> sRGB -> ProPhoto. Raw rgb_cam is never labeled as ProPhoto.
  const double srgb_to_prophoto[9] = {
      0.529280406052, 0.330152985779, 0.140566608169,
      0.098366221918, 0.873463954625, 0.028169823456,
      0.016875340800, 0.117659414517, 0.865465244683,
  };

  if (!isFiniteMatrix3x3(camera_to_srgb)) {
    const double xyz_to_prophoto[9] = {
        1.3459433, -0.2556075, -0.0511118,
        -0.5445989, 1.5081673, 0.0205351,
        0.0, 0.0, 1.2118128,
    };

    for (int row = 0; row < 3; ++row) {
      for (int col = 0; col < 3; ++col) {
        camera_to_working_rgb[row * 3 + col] =
            xyz_to_prophoto[row * 3 + 0] * color.cam_xyz[col][0] +
            xyz_to_prophoto[row * 3 + 1] * color.cam_xyz[col][1] +
            xyz_to_prophoto[row * 3 + 2] * color.cam_xyz[col][2];
      }
    }

    return isFiniteMatrix3x3(camera_to_working_rgb);
  }

  for (int row = 0; row < 3; ++row) {
    for (int col = 0; col < 3; ++col) {
      camera_to_working_rgb[row * 3 + col] =
          srgb_to_prophoto[row * 3 + 0] * camera_to_srgb[0 * 3 + col] +
          srgb_to_prophoto[row * 3 + 1] * camera_to_srgb[1 * 3 + col] +
          srgb_to_prophoto[row * 3 + 2] * camera_to_srgb[2 * 3 + col];
    }
  }

  return isFiniteMatrix3x3(camera_to_working_rgb);
}

void useNeutralProcessedWhiteBalance(double *white_balance) {
  for (int index = 0; index < 4; ++index) {
    white_balance[index] = 1;
  }
}

void useIdentityProcessedColorTransform(double *camera_to_working_rgb) {
  for (int index = 0; index < 9; ++index) {
    camera_to_working_rgb[index] = 0;
  }
  camera_to_working_rgb[0] = 1;
  camera_to_working_rgb[4] = 1;
  camera_to_working_rgb[8] = 1;
}

val unsupportedCapability(const libraw_data_t &imgdata,
                          const std::string &reason) {
  const libraw_image_sizes_t &sizes = imgdata.sizes;
  const libraw_colordata_t &color = imgdata.color;
  const std::string pattern =
      sensorLayoutName(imgdata) == "x-trans" ? "x-trans" : "unsupported";

  val reasons = val::array();
  reasons.set(0, reason);

  val capability = val::object();
  capability.set("supported", false);
  capability.set("width", sizes.width);
  capability.set("height", sizes.height);
  capability.set("rawWidth", sizes.raw_width);
  capability.set("rawHeight", sizes.raw_height);
  capability.set("visibleCrop", visibleCropObject(sizes.left_margin,
                                                   sizes.top_margin,
                                                   sizes.width,
                                                   sizes.height));
  capability.set("cfa", cfaObject("unsupported"));
  capability.set("blackLevel", color.black);
  capability.set("whiteLevel", color.maximum);
  capability.set("orientation", orientationObject(sizes));
  capability.set("sensor", sensorLayoutObject(imgdata, pattern));
  capability.set("levels", levelsObject(color));
  capability.set("windows", windowsObject(imgdata));
  capability.set("diagnostics", diagnosticsObject(imgdata));
  capability.set("reasons", reasons);
  return capability;
}

val unsupportedCapability(const libraw_data_t &imgdata,
                          const std::string &reason,
                          const double *camera_white_balance,
                          const double *camera_to_working_rgb) {
  val capability = unsupportedCapability(imgdata, reason);

  val color_facts = val::object();
  color_facts.set("whiteBalance", numberArray(camera_white_balance, 4));
  color_facts.set("cameraToWorkingRgb",
                  numberArray(camera_to_working_rgb, 9));
  color_facts.set("workingSpace", std::string("linear-prophoto-rgb"));
  color_facts.set("librawOutputColor", std::string("prophoto"));
  color_facts.set("gamma", std::string("linear"));
  color_facts.set("cameraWhiteBalanceAppliedByRuntime", true);
  color_facts.set("cameraMatrixAppliedByRuntime", true);
  capability.set("color", color_facts);

  return capability;
}

val supportedExportCapability(const libraw_data_t &imgdata,
                              const std::string &pattern,
                              const double *camera_white_balance,
                              const double *camera_to_working_rgb) {
  const libraw_image_sizes_t &sizes = imgdata.sizes;
  const libraw_colordata_t &color = imgdata.color;
  const int output_width = processedOutputWidth(sizes);
  const int output_height = processedOutputHeight(sizes);

  val color_facts = val::object();
  color_facts.set("whiteBalance", numberArray(camera_white_balance, 4));
  color_facts.set("cameraToWorkingRgb",
                  numberArray(camera_to_working_rgb, 9));
  color_facts.set("workingSpace", std::string("linear-prophoto-rgb"));
  color_facts.set("librawOutputColor", std::string("prophoto"));
  color_facts.set("gamma", std::string("linear"));
  color_facts.set("cameraWhiteBalanceAppliedByRuntime", true);
  color_facts.set("cameraMatrixAppliedByRuntime", true);

  val capability = val::object();
  capability.set("supported", true);
  capability.set("strategy", std::string("libraw-processed-window"));
  capability.set("width", output_width);
  capability.set("height", output_height);
  capability.set("rawWidth", sizes.raw_width);
  capability.set("rawHeight", sizes.raw_height);
  capability.set("visibleCrop", visibleCropObject(sizes.left_margin,
                                                   sizes.top_margin,
                                                   sizes.width,
                                                   sizes.height));
  capability.set("cfa", cfaObject(pattern));
  capability.set("blackLevel", color.black);
  capability.set("whiteLevel", color.maximum);
  capability.set("orientation", orientationObject(sizes));
  capability.set("sensor", sensorLayoutObject(imgdata, pattern));
  capability.set("levels", levelsObject(color));
  capability.set("windows", windowsObject(imgdata));
  capability.set("diagnostics", diagnosticsObject(imgdata));
  capability.set("color", color_facts);
  capability.set("reasons", val::array());
  return capability;
}

OutputSize planOutputSize(int width, int height, int max_pixels) {
  if (max_pixels <= 0 || static_cast<double>(width) * height <= max_pixels) {
    return {width, height};
  }

  const double scale =
      std::sqrt(static_cast<double>(max_pixels) /
                (static_cast<double>(width) * height));
  int out_width = std::max(1, static_cast<int>(std::floor(width * scale)));
  int out_height = std::max(1, static_cast<int>(std::floor(height * scale)));

  while (static_cast<double>(out_width) * out_height > max_pixels) {
    if (out_width >= out_height) {
      --out_width;
    } else {
      --out_height;
    }
  }

  return {out_width, out_height};
}

int maxOutputPixelsFromOptions(val options) {
  if (options.isNull() || options.isUndefined()) return 0;
  if (!options.hasOwnProperty("maxOutputPixels")) return 0;

  const val raw_max_output_pixels = options["maxOutputPixels"];
  if (raw_max_output_pixels.isNull() || raw_max_output_pixels.isUndefined()) {
    return 0;
  }

  const double max_output_pixels = raw_max_output_pixels.as<double>();
  if (!std::isfinite(max_output_pixels) || max_output_pixels <= 0 ||
      std::floor(max_output_pixels) != max_output_pixels ||
      max_output_pixels > std::numeric_limits<int>::max()) {
    throw std::runtime_error(
        "Luma RAW maxOutputPixels must be a finite positive integer no greater "
        "than INT_MAX.");
  }

  return static_cast<int>(max_output_pixels);
}

// Production subclass exposing the protected LibRaw::cam_xyz_coeff helper so
// applyCalibration() can rebuild rgb_cam / pre_mul from a caller-provided
// XYZ-to-Camera matrix. We deliberately inherit the LibRaw
// normalize+pseudoinverse path rather than reimplementing it.
class LumaCalibrationLibRaw : public LibRaw {
 public:
  using LibRaw::cam_xyz_coeff;
};

class LumaRawProcessor {
 public:
  val loadBuffer(val data) {
    const double copy_start = nowMs();
    input_buffer_ = copyInputBytes(data);
    const double copy_end = nowMs();

    val timings = val::object();
    timings.set("copyToWasm", copy_end - copy_start);
    return timings;
  }

  val openWithSettings(val settings) {
    if (input_buffer_.empty()) {
      throw std::runtime_error("LibRaw input buffer is empty.");
    }

    processor_.recycle();
    unpacked_ = false;
    processed_ = false;

    applySettings(settings);
    const double open_start = nowMs();
    requireLibRawSuccess(
        "LibRaw open_buffer",
        processor_.open_buffer(input_buffer_.data(), input_buffer_.size()));
    const double open_end = nowMs();

    val timings = val::object();
    timings.set("copyToWasm", 0);
    timings.set("librawOpen", open_end - open_start);
    return timings;
  }

  val openBuffer(val data, val settings) {
    val copy_timings = loadBuffer(data);
    val open_timings = openWithSettings(settings);

    val timings = val::object();
    timings.set("copyToWasm", copy_timings["copyToWasm"].as<double>());
    timings.set("librawOpen", open_timings["librawOpen"].as<double>());
    return timings;
  }

  val readMetadata() {
    const libraw_data_t &imgdata = processor_.imgdata;
    const libraw_image_sizes_t &sizes = imgdata.sizes;
    const libraw_iparams_t &idata = imgdata.idata;
    const libraw_lensinfo_t &lens = imgdata.lens;
    const libraw_imgother_t &other = imgdata.other;
    const libraw_colordata_t &color = imgdata.color;
    const libraw_thumbnail_t &thumbnail = imgdata.thumbnail;

    val metadata = val::object();
    metadata.set("width", sizes.width);
    metadata.set("height", sizes.height);
    metadata.set("rawWidth", sizes.raw_width);
    metadata.set("rawHeight", sizes.raw_height);
    metadata.set("make", safeString(idata.make));
    metadata.set("model", safeString(idata.model));
    metadata.set("lens", safeString(lens.Lens));
    metadata.set("iso", other.iso_speed);
    metadata.set("aperture", other.aperture);
    metadata.set("focalLength", other.focal_len);
    metadata.set("shutter", other.shutter);
    metadata.set("timestamp", static_cast<double>(other.timestamp));
    metadata.set("orientation", sizes.flip);
    metadata.set("blackLevel", color.black);
    metadata.set("whiteLevel", color.maximum);
    metadata.set("dataMaximum", color.data_maximum);

    val black_stat = val::array();
    for (int i = 0; i < 8; ++i) {
      black_stat.set(i, color.black_stat[i]);
    }
    metadata.set("blackStat", black_stat);

    val per_channel_black = val::array();
    for (int i = 0; i < 4; ++i) {
      per_channel_black.set(i, color.cblack[i]);
    }
    metadata.set("perChannelBlack", per_channel_black);

    const float baseline_exposure = color.dng_levels.baseline_exposure;
    if (std::isfinite(baseline_exposure) && baseline_exposure > -999.0f) {
      metadata.set("baselineExposure", baseline_exposure);
    }
    metadata.set("thumbWidth", thumbnail.twidth);
    metadata.set("thumbHeight", thumbnail.theight);
    metadata.set("thumbFormat", thumbnailFormat(thumbnail.tformat));
    return metadata;
  }

  val extractThumbnail() {
    int code = processor_.unpack_thumb();
    if (isUnavailableThumbnailError(code)) {
      return val::undefined();
    }
    requireLibRawSuccess("LibRaw unpack_thumb", code);

    int image_error = LIBRAW_SUCCESS;
    std::unique_ptr<libraw_processed_image_t, decltype(&LibRaw::dcraw_clear_mem)>
        image(processor_.dcraw_make_mem_thumb(&image_error),
              &LibRaw::dcraw_clear_mem);
    if (!image) {
      if (isUnavailableThumbnailError(image_error)) {
        return val::undefined();
      }
      requireLibRawSuccess("LibRaw dcraw_make_mem_thumb", image_error);
      return val::undefined();
    }

    const int fallback_width = processor_.imgdata.thumbnail.twidth;
    const int fallback_height = processor_.imgdata.thumbnail.theight;
    const int width = image->width > 0 ? image->width : fallback_width;
    const int height = image->height > 0 ? image->height : fallback_height;

    val thumbnail = val::object();
    thumbnail.set("data", copiedUint8Array(image->data, image->data_size));
    thumbnail.set("width", width);
    thumbnail.set("height", height);
    thumbnail.set("thumbWidth", fallback_width);
    thumbnail.set("thumbHeight", fallback_height);
    thumbnail.set("format", processedImageFormat(image->type));
    return thumbnail;
  }

  val decodePreview(val options = val::undefined()) {
    return decodeImage(maxOutputPixelsFromOptions(options));
  }

  val decodeHq(val options = val::undefined()) {
    return decodeImage(maxOutputPixelsFromOptions(options));
  }

  // Inject a caller-provided XYZ-to-Camera 3x3 matrix into LibRaw color state
  // so the next dcraw_process() consumes the calibration. The matrix follows
  // DNG ColorMatrix1/2 convention (the same direction LibRaw's
  // imgdata.color.cam_xyz holds), row-major length 9.
  //
  // The caller is responsible for solving the dual-illuminant interpolation
  // (DNG-spec inverse-CCT alpha) before invoking this entry — the wrapper
  // never sees raw illuminants. See
  // packages/luma-color-runtime/src/dcp-interpolate.ts (phase 2 producer).
  //
  // Sequencing requirements verified by the native spike:
  //   1. Mirror cam_xyz into BOTH imgdata.color AND imgdata.rawdata.color.
  //      raw2image_start (src/preprocessing/raw2image.cpp:21) memmoves
  //      &imgdata.rawdata.color over &imgdata.color at the top of every
  //      dcraw_process; mutations to imgdata.color alone are silently
  //      reverted to the cmatrix-derived baseline.
  //   2. Rebuild rgb_cam / pre_mul via LibRaw::cam_xyz_coeff (exposed via
  //      LumaCalibrationLibRaw). Computing rgb_cam by hand or writing it
  //      directly are possible fallbacks, both unused.
  //   3. Mirror the rebuilt rgb_cam and pre_mul into imgdata.rawdata.color
  //      for the same raw2image_start reason.
  //   4. Leave params.use_camera_matrix = 1 (the strict-export default).
  //      Setting it to 0 routes LibRaw through the raw_color=1 branch in
  //      convert_to_rgb_loop and skips out_cam entirely, defeating the
  //      injection.
  //
  // Requires the session to have been opened and unpacked. The wrapper does
  // not call unpack/dcraw_process here; the next decode/processed-window read
  // will pick up the new color state.
  //
  // PHASE 1 LIMITATION: when toneCurveLut is provided, the wrapper stashes
  // it on the session as a std::vector<float> for a future post-process pass
  // (per DNG spec, ToneCurve runs after the matrix in linear working space,
  // before output gamma). The per-pixel LUT pass is NOT implemented yet.
  void applyCalibration(val params) {
    if (input_buffer_.empty()) {
      throw std::runtime_error(
          "LibRaw input buffer is empty; applyCalibration requires the "
          "session to be open.");
    }

    if (params.isNull() || params.isUndefined() ||
        !params.hasOwnProperty("xyzToCamera")) {
      throw std::runtime_error(
          "applyCalibration params must include an xyzToCamera matrix.");
    }

    const val matrix = params["xyzToCamera"];
    if (matrix.isNull() || matrix.isUndefined() ||
        matrix["length"].as<int>() != 9) {
      throw std::runtime_error(
          "applyCalibration xyzToCamera must be a length-9 numeric array.");
    }

    double xyz_to_camera[9];
    for (int i = 0; i < 9; ++i) {
      const double value = matrix[i].as<double>();
      if (!std::isfinite(value)) {
        throw std::runtime_error(
            "applyCalibration xyzToCamera contains a non-finite value.");
      }
      xyz_to_camera[i] = value;
    }

    ensureUnpacked();

    libraw_colordata_t &color = processor_.imgdata.color;
    libraw_colordata_t &raw_color = processor_.imgdata.rawdata.color;

    // (1) Write the new XYZ-to-Camera 3x3 into imgdata.color.cam_xyz (shape
    // [4][3], float). Rows 0..2 carry the matrix; the 4th camera-color row
    // stays zero for 3-color cameras. Mirror to rawdata.color.cam_xyz to
    // survive raw2image_start's memmove on the next dcraw_process.
    for (int row = 0; row < 3; ++row) {
      for (int col = 0; col < 3; ++col) {
        const float value = static_cast<float>(xyz_to_camera[row * 3 + col]);
        color.cam_xyz[row][col] = value;
        raw_color.cam_xyz[row][col] = value;
      }
    }
    if (processor_.imgdata.idata.colors > 3) {
      for (int col = 0; col < 3; ++col) {
        color.cam_xyz[3][col] = 0.f;
        raw_color.cam_xyz[3][col] = 0.f;
      }
    }

    // (2) Rebuild rgb_cam / pre_mul via LibRaw::cam_xyz_coeff. The helper
    // expects double[4][3]; copy from the caller matrix directly to avoid the
    // float storage round-trip through imgdata.color.cam_xyz.
    double cam_xyz_double[4][3] = {{0}};
    for (int row = 0; row < 3; ++row) {
      for (int col = 0; col < 3; ++col) {
        cam_xyz_double[row][col] = xyz_to_camera[row * 3 + col];
      }
    }
    processor_.cam_xyz_coeff(color.rgb_cam, cam_xyz_double);

    // (3) Mirror the rebuilt rgb_cam (full [3][4] including the X-Trans /
    // 4-color slot, which we want zeroed on 3-color cameras) and pre_mul
    // into imgdata.rawdata.color. pre_mul will be overridden by
    // scale_colors() under use_camera_wb=1 when cam_mul is valid; this is
    // expected per the spike audit's "DCP affects matrix, not WB scalars"
    // semantics (Phase 1).
    for (int r = 0; r < 3; ++r) {
      for (int c = 0; c < 4; ++c) {
        raw_color.rgb_cam[r][c] = color.rgb_cam[r][c];
      }
    }
    for (int i = 0; i < 4; ++i) {
      raw_color.pre_mul[i] = color.pre_mul[i];
    }

    // (4) Force use_camera_matrix=1 so convert_to_rgb honors the injected
    // rgb_cam. The strict-export quickSettings/hqSettings already set this,
    // but the openSession path may have been re-applied with different
    // settings; re-asserting it here makes applyCalibration safe to call
    // outside the export window.
    processor_.imgdata.params.use_camera_matrix = 1;

    // (5) Mark the next decode as "not yet processed" so processed_ doesn't
    // short-circuit the dcraw_process call that consumes the new color
    // state. unpacked_ stays true — the rawdata mosaic is unchanged.
    processed_ = false;

    // (6) PHASE 1: stash toneCurveLut on the session for a future
    // post-process pass. The pass itself is intentionally deferred so this
    // PR can ship the matrix path without holding it for a per-channel LUT
    // implementation. See the comment block at the top of this method.
    //
    // Each applyCalibration() resets the stash so the previous profile's
    // curve cannot leak into a profile that ships matrix-only.
    tone_curve_lut_.clear();
    if (params.hasOwnProperty("toneCurveLut")) {
      const val lut = params["toneCurveLut"];
      if (!lut.isNull() && !lut.isUndefined()) {
        const int length = lut["length"].as<int>();
        if (length < 4096) {
          throw std::runtime_error(
              "applyCalibration toneCurveLut must have at least 4096 "
              "entries.");
        }
        tone_curve_lut_.resize(static_cast<size_t>(length));
        for (int i = 0; i < length; ++i) {
          const double value = lut[i].as<double>();
          if (!std::isfinite(value)) {
            throw std::runtime_error(
                "applyCalibration toneCurveLut contains a non-finite "
                "value.");
          }
          tone_curve_lut_[static_cast<size_t>(i)] = static_cast<float>(value);
        }
      }
    }
  }

  val probeExportCapability() {
    ensureUnpacked();
    const libraw_data_t &imgdata = processor_.imgdata;
    const libraw_image_sizes_t &sizes = imgdata.sizes;
    const libraw_colordata_t &color = imgdata.color;

    if (!hasPositiveImageDimensions(sizes)) {
      return unsupportedCapability(imgdata, "missing-dimensions");
    }
    if (!hasValidLevels(color)) {
      return unsupportedCapability(imgdata, "missing-levels");
    }

    const std::string layout = sensorLayoutName(imgdata);
    if (layout == "unknown") {
      return unsupportedCapability(imgdata, "unsupported-sensor-layout");
    }

    if (!usesFixedExportPolicy(imgdata.params)) {
      return unsupportedCapability(imgdata, "missing-color-transform");
    }

    std::string pattern = "unsupported";
    if (layout == "bayer") {
      pattern = cfaPatternName(processor_);
    } else if (layout == "x-trans") {
      pattern = "x-trans";
    }

    double camera_white_balance[4] = {0, 0, 0, 0};
    double camera_to_working_rgb[9] = {0, 0, 0, 0, 0, 0, 0, 0, 0};

    if (!selectCameraWhiteBalance(color, camera_white_balance)) {
      useNeutralProcessedWhiteBalance(camera_white_balance);
    }
    if (!buildCameraToWorkingRgb(color, camera_to_working_rgb)) {
      useIdentityProcessedColorTransform(camera_to_working_rgb);
    }
    if (!hasVisibleCropWithinRaw(sizes)) {
      return unsupportedCapability(imgdata, "missing-visible-crop");
    }
    if (!supportsProcessedWindowOrientation(sizes.flip)) {
      return unsupportedCapability(imgdata, "unsupported-orientation",
                                   camera_white_balance,
                                   camera_to_working_rgb);
    }
    if (!supportsProcessedWindow(imgdata)) {
      return unsupportedCapability(imgdata, "processed-window-unavailable",
                                   camera_white_balance,
                                   camera_to_working_rgb);
    }

    return supportedExportCapability(imgdata, pattern, camera_white_balance,
                                     camera_to_working_rgb);
  }

  val readRawWindow(val rect) {
    ensureUnpacked();
    const libraw_data_t &imgdata = processor_.imgdata;
    const libraw_image_sizes_t &sizes = imgdata.sizes;
    const libraw_colordata_t &color = imgdata.color;

    if (sizes.width <= 0 || sizes.height <= 0 || sizes.raw_width <= 0 ||
        sizes.raw_height <= 0 || color.maximum <= color.black ||
        !hasBayerRawImage(imgdata)) {
      throw std::runtime_error("LibRaw raw-window access is unavailable.");
    }

    const std::string pattern = cfaPatternName(processor_);
    if (pattern == "unsupported") {
      throw std::runtime_error("LibRaw raw-window access is unavailable.");
    }

    const int x = rect["x"].as<int>();
    const int y = rect["y"].as<int>();
    const int width = rect["width"].as<int>();
    const int height = rect["height"].as<int>();
    if (x < 0 || y < 0 || width <= 0 || height <= 0 ||
        width > sizes.raw_width || height > sizes.raw_height ||
        x > sizes.raw_width - width || y > sizes.raw_height - height) {
      throw std::runtime_error("RAW window rect is outside the RAW bounds.");
    }

    const uint16_t *source = imgdata.rawdata.raw_image;
    std::vector<uint16_t> window(
        checkedMultiply(static_cast<size_t>(width), static_cast<size_t>(height),
                        "RAW window pixel count"));

    for (int row = 0; row < height; ++row) {
      const size_t src = static_cast<size_t>(y + row) * sizes.raw_width + x;
      const size_t dst = static_cast<size_t>(row) * width;
      std::copy(source + src, source + src + width, window.data() + dst);
    }

    val out_rect = val::object();
    out_rect.set("x", x);
    out_rect.set("y", y);
    out_rect.set("width", width);
    out_rect.set("height", height);

    val output = val::object();
    output.set("rect", out_rect);
    output.set("cfa", cfaObject(pattern));
    output.set("data", copiedUint16Array(window.data(), window.size()));
    output.set("blackLevel", color.black);
    output.set("whiteLevel", color.maximum);
    return output;
  }

  val readProcessedWindow(val request) {
    const double total_start = nowMs();
    const double setup_start = total_start;
    ensureUnpacked();

    const libraw_data_t &imgdata = processor_.imgdata;
    const libraw_image_sizes_t &sizes = imgdata.sizes;
    if (!supportsRepeatableCropProcess(imgdata)) {
      throw std::runtime_error(
          "LibRaw cropbox processed-window access is unavailable.");
    }

    const WindowRect output_rect = parseOutputRect(request);
    const WindowHalo halo = parseWindowHalo(request);
    const int orientation = normalizedOrientationCode(sizes.flip);
    if (!supportsProcessedWindowOrientation(orientation)) {
      throw std::runtime_error(
          "LibRaw processed-window orientation is unsupported.");
    }
    const int output_width = processedOutputWidth(sizes);
    const int output_height = processedOutputHeight(sizes);
    const WindowRect expanded_output_rect =
        expandOutputRect(output_rect, halo, output_width, output_height);
    const WindowRect source_crop = sourceCropForOutputRect(
        expanded_output_rect, sizes.width, sizes.height, orientation);

    if (source_crop.x < 0 || source_crop.y < 0 || source_crop.width <= 0 ||
        source_crop.height <= 0 ||
        source_crop.x > sizes.width - source_crop.width ||
        source_crop.y > sizes.height - source_crop.height) {
      throw std::runtime_error(
          "LibRaw cropbox processed-window source crop is outside image "
          "bounds.");
    }

    auto crop_processor = std::make_unique<LibRaw>();
    libraw_output_params_t &params = crop_processor->imgdata.params;
    applyStrictExportProcessingSettings(params);
    const double setup_end = nowMs();

    const double open_start = setup_end;
    requireLibRawSuccess(
        "LibRaw cropbox open_buffer",
        crop_processor->open_buffer(input_buffer_.data(), input_buffer_.size()));
    const double open_end = nowMs();

    const double unpack_start = open_end;
    requireLibRawSuccess("LibRaw cropbox unpack", crop_processor->unpack());
    const double unpack_end = nowMs();

    const double process_start = unpack_end;
    params.cropbox[0] = static_cast<unsigned>(source_crop.x);
    params.cropbox[1] = static_cast<unsigned>(source_crop.y);
    params.cropbox[2] = static_cast<unsigned>(source_crop.width);
    params.cropbox[3] = static_cast<unsigned>(source_crop.height);

    requireLibRawSuccess("LibRaw dcraw_process",
                         crop_processor->dcraw_process());
    const double process_end = nowMs();

    double output_copy_ms = 0;
    const double libraw_copy_start = process_end;
    int crop_width = 0;
    int crop_height = 0;
    int colors = 0;
    int bits_per_sample = 0;
    crop_processor->get_mem_image_format(&crop_width, &crop_height, &colors,
                                         &bits_per_sample);

    if (colors != 3 || bits_per_sample != 16 || crop_width <= 0 ||
        crop_height <= 0) {
      throw std::runtime_error(
          "LibRaw cropbox output is not the expected RGB16 bitmap image.");
    }

    const int expected_crop_width =
        orientationSwapsAxes(orientation) ? expanded_output_rect.height
                                         : expanded_output_rect.width;
    const int expected_crop_height =
        orientationSwapsAxes(orientation) ? expanded_output_rect.width
                                         : expanded_output_rect.height;
    if (crop_width != expected_crop_width ||
        crop_height != expected_crop_height) {
      throw std::runtime_error(
          "LibRaw cropbox output dimensions do not match requested window.");
    }

    const size_t crop_pixel_count =
        checkedMultiply(static_cast<size_t>(crop_width),
                        static_cast<size_t>(crop_height),
                        "LibRaw cropbox RGB16 pixel count");
    const size_t crop_sample_count =
        checkedMultiply(crop_pixel_count, static_cast<size_t>(3),
                        "LibRaw cropbox RGB16 sample count");
    std::vector<uint16_t> crop_data(crop_sample_count);
    const int crop_stride = crop_width * 3 * static_cast<int>(sizeof(uint16_t));
    requireLibRawSuccess("LibRaw copy_mem_image",
                         crop_processor->copy_mem_image(crop_data.data(),
                                                        crop_stride, 0));
    crop_processor->free_image();
    const double libraw_copy_end = nowMs();
    output_copy_ms += libraw_copy_end - libraw_copy_start;

    const double orientation_start = libraw_copy_end;
    const size_t expanded_pixel_count =
        checkedMultiply(static_cast<size_t>(expanded_output_rect.width),
                        static_cast<size_t>(expanded_output_rect.height),
                        "Luma RAW expanded processed-window pixel count");
    const size_t expanded_sample_count =
        checkedMultiply(expanded_pixel_count, static_cast<size_t>(3),
                        "Luma RAW expanded processed-window sample count");
    std::vector<uint16_t> expanded_data(expanded_sample_count);

    for (int y = 0; y < expanded_output_rect.height; ++y) {
      for (int x = 0; x < expanded_output_rect.width; ++x) {
        int sx = x;
        int sy = y;

        switch (orientation) {
          case 1:
            break;
          case 3:
            sx = expanded_output_rect.width - 1 - x;
            sy = expanded_output_rect.height - 1 - y;
            break;
          case 5:
          case 8:
            sx = expanded_output_rect.height - 1 - y;
            sy = x;
            break;
          case 6:
            sx = y;
            sy = expanded_output_rect.width - 1 - x;
            break;
          default:
            throw std::runtime_error(
                "LibRaw processed-window orientation is unsupported.");
        }

        const size_t src = (static_cast<size_t>(sy) * crop_width + sx) * 3;
        const size_t dst =
            (static_cast<size_t>(y) * expanded_output_rect.width + x) * 3;
        expanded_data[dst] = crop_data[src];
        expanded_data[dst + 1] = crop_data[src + 1];
        expanded_data[dst + 2] = crop_data[src + 2];
      }
    }
    const double orientation_end = nowMs();

    const double output_copy_start = orientation_end;
    const size_t output_pixel_count =
        checkedMultiply(static_cast<size_t>(output_rect.width),
                        static_cast<size_t>(output_rect.height),
                        "Luma RAW processed-window pixel count");
    const size_t output_sample_count =
        checkedMultiply(output_pixel_count, static_cast<size_t>(3),
                        "Luma RAW processed-window sample count");
    std::vector<uint16_t> output_data(output_sample_count);
    const int local_x = output_rect.x - expanded_output_rect.x;
    const int local_y = output_rect.y - expanded_output_rect.y;

    for (int y = 0; y < output_rect.height; ++y) {
      const size_t src =
          (static_cast<size_t>(local_y + y) * expanded_output_rect.width +
           local_x) *
          3;
      const size_t dst = static_cast<size_t>(y) * output_rect.width * 3;
      std::copy(expanded_data.data() + src,
                expanded_data.data() + src + output_rect.width * 3,
                output_data.data() + dst);
    }

    const int warning_mask = processor_.imgdata.process_warnings;
    const int crop_warning_mask = crop_processor->imgdata.process_warnings;

    val warnings = val::array();
    if ((warning_mask | crop_warning_mask) != 0) {
      warnings.set(
          0, std::string("libraw-process-warnings:") +
                 std::to_string(warning_mask | crop_warning_mask));
    }

    val data = copiedUint16Array(output_data.data(), output_data.size());
    const double output_copy_end = nowMs();
    output_copy_ms += output_copy_end - output_copy_start;

    val output = val::object();
    output.set("rect", rectObject(output_rect));
    output.set("workingSpace", std::string("linear-prophoto-rgb"));
    output.set("data", data);
    output.set("width", output_rect.width);
    output.set("height", output_rect.height);
    output.set("stride", output_rect.width * 3);
    output.set("normalized", false);
    output.set("orientationApplied", true);
    output.set("colorApplied", true);
    output.set("warnings", warnings);
    const double total_end = nowMs();
    output.set("timings",
               timingObject(setup_end - setup_start, open_end - open_start,
                            unpack_end - unpack_start,
                            process_end - process_start, output_copy_ms,
                            orientation_end - orientation_start,
                            total_end - total_start));
    return output;
  }

 private:
  void applySettings(val settings) {
    libraw_output_params_t &params = processor_.imgdata.params;
    params.half_size = settings["halfSize"].as<bool>() ? 1 : 0;
    params.use_camera_wb = settings["useCameraWb"].as<bool>() ? 1 : 0;
    params.output_color = settings["outputColor"].as<int>();
    params.output_bps = settings["outputBps"].as<int>();
    params.no_auto_bright = settings["noAutoBright"].as<bool>() ? 1 : 0;
    params.use_auto_wb = settings["useAutoWb"].as<bool>() ? 1 : 0;
    params.use_camera_matrix = settings["useCameraMatrix"].as<int>();
    params.bright = settings["bright"].as<float>();
    params.highlight = settings["highlight"].as<int>();
    params.user_qual = settings["userQual"].as<int>();

    val gamma = settings["gamm"];
    for (int i = 0; i < 6; ++i) {
      params.gamm[i] = gamma[i].as<double>();
    }
  }

  void ensureUnpacked() {
    if (unpacked_) {
      return;
    }

    requireLibRawSuccess("LibRaw unpack", processor_.unpack());
    unpacked_ = true;
  }

  void ensureProcessed() {
    if (processed_) {
      return;
    }

    ensureUnpacked();
    requireLibRawSuccess("LibRaw dcraw_process", processor_.dcraw_process());
    processed_ = true;
  }

  val decodeImage(int max_output_pixels) {
    ensureProcessed();

    int image_error = LIBRAW_SUCCESS;
    std::unique_ptr<libraw_processed_image_t, decltype(&LibRaw::dcraw_clear_mem)>
        image(processor_.dcraw_make_mem_image(&image_error),
              &LibRaw::dcraw_clear_mem);
    if (!image) {
      requireLibRawSuccess("LibRaw dcraw_make_mem_image", image_error);
      throw std::runtime_error("LibRaw dcraw_make_mem_image returned no image.");
    }

    if (image->type != LIBRAW_IMAGE_BITMAP || image->colors != 3 ||
        image->bits != 16) {
      throw std::runtime_error(
          "LibRaw output is not the expected RGB16 bitmap image.");
    }

    const size_t pixel_count =
        checkedMultiply(static_cast<size_t>(image->width),
                        static_cast<size_t>(image->height),
                        "LibRaw RGB16 pixel count");
    const size_t sample_count =
        checkedMultiply(pixel_count, static_cast<size_t>(image->colors),
                        "LibRaw RGB16 sample count");
    const size_t byte_count =
        checkedMultiply(sample_count, sizeof(uint16_t),
                        "LibRaw RGB16 byte count");
    if (image->data_size < byte_count) {
      throw std::runtime_error(
          "LibRaw RGB16 image buffer is smaller than expected.");
    }

    const OutputSize output_size =
        planOutputSize(image->width, image->height, max_output_pixels);
    const uint16_t *source = reinterpret_cast<const uint16_t *>(image->data);

    val output = val::object();
    if (output_size.width == image->width &&
        output_size.height == image->height) {
      output.set("data", copiedUint16Array(source, sample_count));
      output.set("width", image->width);
      output.set("height", image->height);
      return output;
    }

    const size_t output_pixel_count =
        checkedMultiply(static_cast<size_t>(output_size.width),
                        static_cast<size_t>(output_size.height),
                        "Luma RAW downsample pixel count");
    const size_t output_sample_count =
        checkedMultiply(output_pixel_count, static_cast<size_t>(3),
                        "Luma RAW downsample sample count");
    std::vector<uint16_t> resized(output_sample_count);

    for (int y = 0; y < output_size.height; ++y) {
      const int source_y = std::min(
          image->height - 1,
          static_cast<int>(std::floor(((static_cast<double>(y) + 0.5) *
                                       image->height) /
                                      output_size.height)));
      for (int x = 0; x < output_size.width; ++x) {
        const int source_x = std::min(
            image->width - 1,
            static_cast<int>(std::floor(((static_cast<double>(x) + 0.5) *
                                         image->width) /
                                        output_size.width)));
        const size_t src =
            (static_cast<size_t>(source_y) * image->width + source_x) * 3;
        const size_t dst =
            (static_cast<size_t>(y) * output_size.width + x) * 3;
        resized[dst] = source[src];
        resized[dst + 1] = source[src + 1];
        resized[dst + 2] = source[src + 2];
      }
    }

    output.set("data", copiedUint16Array(resized.data(), resized.size()));
    output.set("width", output_size.width);
    output.set("height", output_size.height);
    return output;
  }

  LumaCalibrationLibRaw processor_;
  std::vector<unsigned char> input_buffer_;
  // Phase 1: stashed for a future post-process tone-curve pass. Not yet
  // consumed by dcraw_process; see applyCalibration() for the deferred
  // implementation note.
  std::vector<float> tone_curve_lut_;
  bool unpacked_ = false;
  bool processed_ = false;
};

}  // namespace

EMSCRIPTEN_BINDINGS(luma_raw_runtime) {
  class_<LumaRawProcessor>("LumaRawProcessor")
      .constructor<>()
      .function("loadBuffer", &LumaRawProcessor::loadBuffer)
      .function("openWithSettings", &LumaRawProcessor::openWithSettings)
      .function("openBuffer", &LumaRawProcessor::openBuffer)
      .function("readMetadata", &LumaRawProcessor::readMetadata)
      .function("extractThumbnail", &LumaRawProcessor::extractThumbnail)
      .function("probeExportCapability",
                &LumaRawProcessor::probeExportCapability)
      .function("readRawWindow", &LumaRawProcessor::readRawWindow)
      .function("readProcessedWindow", &LumaRawProcessor::readProcessedWindow)
      .function("decodePreview", &LumaRawProcessor::decodePreview)
      .function("decodeHq", &LumaRawProcessor::decodeHq)
      .function("applyCalibration", &LumaRawProcessor::applyCalibration);
}
