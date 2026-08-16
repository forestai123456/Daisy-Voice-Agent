#include <node_api.h>

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

#include <cmath>
#include <cstdint>
#include <unordered_set>

namespace {

void SetNamedProperty(napi_env env, napi_value object, const char* name, napi_value value) {
  napi_set_named_property(env, object, name, value);
}

napi_value MakeBoolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value MakeInt32(napi_env env, int32_t value) {
  napi_value result;
  napi_create_int32(env, value, &result);
  return result;
}

napi_value MakeUint32(napi_env env, uint32_t value) {
  napi_value result;
  napi_create_uint32(env, value, &result);
  return result;
}

napi_value MakeString(napi_env env, NSString* value) {
  napi_value result;
  const char* utf8 = value.UTF8String ?: "";
  napi_create_string_utf8(env, utf8, NAPI_AUTO_LENGTH, &result);
  return result;
}

std::unordered_set<uint32_t> ReadExcludedWindowIds(
    napi_env env,
    size_t argc,
    napi_value* argv) {
  std::unordered_set<uint32_t> excluded;
  if (argc == 0) return excluded;

  bool isArray = false;
  if (napi_is_array(env, argv[0], &isArray) != napi_ok || !isArray) return excluded;

  uint32_t length = 0;
  if (napi_get_array_length(env, argv[0], &length) != napi_ok) return excluded;

  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    uint32_t windowId = 0;
    if (napi_get_element(env, argv[0], index, &item) == napi_ok &&
        napi_get_value_uint32(env, item, &windowId) == napi_ok) {
      excluded.insert(windowId);
    }
  }
  return excluded;
}

napi_value SelectTopmostWindow(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const auto excludedWindowIds = ReadExcludedWindowIds(env, argc, argv);

  napi_value result;
  napi_create_object(env, &result);

  // This runs inside Daisy's Electron main process, so macOS evaluates screen
  // capture access against com.daisy.dev instead of a separately launched helper.
  const bool captureAuthorized = CGPreflightScreenCaptureAccess();
  SetNamedProperty(env, result, "authorized", MakeBoolean(env, captureAuthorized));

  const CGWindowListOption options =
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
  CFArrayRef rawWindowArray = CGWindowListCopyWindowInfo(options, kCGNullWindowID);
  NSArray<NSDictionary*>* rawWindows =
      CFBridgingRelease(rawWindowArray) ?: @[];
  SetNamedProperty(
      env,
      result,
      "rawWindowCount",
      MakeUint32(env, static_cast<uint32_t>(rawWindows.count)));

  NSDictionary* selectedWindow = nil;
  CGRect selectedBounds = CGRectZero;

  if (captureAuthorized) {
    // Core Graphics returns this list in front-to-back z-order. Keep the first
    // normal, visible, shareable application window that is not Daisy's orb.
    for (NSDictionary* rawWindow in rawWindows) {
      NSNumber* windowNumber = rawWindow[(id)kCGWindowNumber];
      NSString* owner = rawWindow[(id)kCGWindowOwnerName];
      NSNumber* layerNumber = rawWindow[(id)kCGWindowLayer];
      NSNumber* alphaNumber = rawWindow[(id)kCGWindowAlpha];
      NSDictionary* boundsDictionary = rawWindow[(id)kCGWindowBounds];

      CGRect bounds = CGRectZero;
      if (!windowNumber || !owner || !layerNumber || !alphaNumber ||
          !boundsDictionary ||
          !CGRectMakeWithDictionaryRepresentation(
              (__bridge CFDictionaryRef)boundsDictionary,
              &bounds)) {
        continue;
      }

      const uint32_t windowId = windowNumber.unsignedIntValue;
      const int layer = layerNumber.intValue;
      const double alpha = alphaNumber.doubleValue;
      const NSNumber* sharingState = rawWindow[(id)kCGWindowSharingState];

      if (layer != 0 || alpha <= 0) continue;
      if (bounds.size.width < 20 || bounds.size.height < 20) continue;
      if (sharingState && sharingState.intValue == kCGWindowSharingNone) continue;
      if (excludedWindowIds.find(windowId) != excludedWindowIds.end()) continue;

      selectedWindow = rawWindow;
      selectedBounds = bounds;
      break;
    }
  }

  if (!selectedWindow) {
    napi_value nullValue;
    napi_get_null(env, &nullValue);
    SetNamedProperty(env, result, "window", nullValue);
    return result;
  }

  napi_value window;
  napi_create_object(env, &window);

  NSNumber* windowNumber = selectedWindow[(id)kCGWindowNumber];
  NSString* owner = selectedWindow[(id)kCGWindowOwnerName] ?: @"";
  NSString* name = selectedWindow[(id)kCGWindowName] ?: @"";
  NSNumber* layerNumber = selectedWindow[(id)kCGWindowLayer];

  SetNamedProperty(env, window, "id", MakeUint32(env, windowNumber.unsignedIntValue));
  SetNamedProperty(env, window, "owner", MakeString(env, owner));
  SetNamedProperty(env, window, "name", MakeString(env, name));
  SetNamedProperty(env, window, "layer", MakeInt32(env, layerNumber.intValue));
  SetNamedProperty(env, window, "x", MakeInt32(env, static_cast<int32_t>(std::lround(selectedBounds.origin.x))));
  SetNamedProperty(env, window, "y", MakeInt32(env, static_cast<int32_t>(std::lround(selectedBounds.origin.y))));
  SetNamedProperty(env, window, "width", MakeInt32(env, static_cast<int32_t>(std::lround(selectedBounds.size.width))));
  SetNamedProperty(env, window, "height", MakeInt32(env, static_cast<int32_t>(std::lround(selectedBounds.size.height))));
  SetNamedProperty(env, result, "window", window);
  return result;
}

// Electron exposes an NSView* as BrowserWindow's macOS native handle.  Its
// high-level workspace API does not opt a window into the newer Stage Manager
// / other-app-fullscreen collection behavior, so apply that behavior directly
// to the owning NSWindow for Daisy's non-interactive overlays.
napi_value ConfigureOverlay(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  void* data = nullptr;
  size_t byteLength = 0;
  if (argc < 1 ||
      napi_get_buffer_info(env, argv[0], &data, &byteLength) != napi_ok ||
      !data || byteLength < sizeof(NSView*)) {
    return MakeBoolean(env, false);
  }

  NSView* __unsafe_unretained view = nil;
  memcpy((void*)&view, data, sizeof(view));
  if (!view) return MakeBoolean(env, false);

  __block bool configured = false;
  void (^configure)(void) = ^{
    NSWindow* window = view.window;
    if (!window) return;

    NSWindowCollectionBehavior behavior =
        NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorFullScreenAuxiliary |
        NSWindowCollectionBehaviorStationary |
        NSWindowCollectionBehaviorIgnoresCycle;

    // On modern macOS this is the specific behavior that permits a floating
    // utility window to join another application's fullscreen / Stage Manager
    // space. It is unavailable on older systems, which retain the flags above.
    if (@available(macOS 13.0, *)) {
      behavior |= NSWindowCollectionBehaviorCanJoinAllApplications;
    }

    [window setCollectionBehavior:behavior];
    [window setLevel:NSScreenSaverWindowLevel + 1];
    [window setHidesOnDeactivate:NO];
    configured = true;
  };

  if ([NSThread isMainThread]) {
    configure();
  } else {
    // Electron's JavaScript main process can be waiting on the AppKit main
    // run loop. Dispatching synchronously here deadlocks startup, so queue the
    // mutation and let the current native call return immediately.
    dispatch_async(dispatch_get_main_queue(), configure);
    configured = true;
  }

  return MakeBoolean(env, configured);
}

napi_value RaiseOverlay(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  void* data = nullptr;
  size_t byteLength = 0;
  if (argc < 1 ||
      napi_get_buffer_info(env, argv[0], &data, &byteLength) != napi_ok ||
      !data || byteLength < sizeof(NSView*)) {
    return MakeBoolean(env, false);
  }

  NSView* __unsafe_unretained view = nil;
  memcpy((void*)&view, data, sizeof(view));
  if (!view) return MakeBoolean(env, false);

  __block bool raised = false;
  void (^raise)(void) = ^{
    NSWindow* window = view.window;
    if (!window) return;
    [window orderFrontRegardless];
    raised = true;
  };

  if ([NSThread isMainThread]) {
    raise();
  } else {
    dispatch_async(dispatch_get_main_queue(), raise);
    raised = true;
  }

  return MakeBoolean(env, raised);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value selectTopmostWindow;
  napi_create_function(
      env,
      "selectTopmostWindow",
      NAPI_AUTO_LENGTH,
      SelectTopmostWindow,
      nullptr,
      &selectTopmostWindow);
  SetNamedProperty(env, exports, "selectTopmostWindow", selectTopmostWindow);

  napi_value configureOverlay;
  napi_create_function(
      env,
      "configureOverlay",
      NAPI_AUTO_LENGTH,
      ConfigureOverlay,
      nullptr,
      &configureOverlay);
  SetNamedProperty(env, exports, "configureOverlay", configureOverlay);

  napi_value raiseOverlay;
  napi_create_function(
      env,
      "raiseOverlay",
      NAPI_AUTO_LENGTH,
      RaiseOverlay,
      nullptr,
      &raiseOverlay);
  SetNamedProperty(env, exports, "raiseOverlay", raiseOverlay);
  return exports;
}

}  // namespace

NAPI_MODULE(daisy_window_selector, Init)
