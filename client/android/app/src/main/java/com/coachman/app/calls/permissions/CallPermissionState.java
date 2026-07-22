package com.coachman.app.calls.permissions;

import com.getcapacitor.JSObject;

/** Snapshot of call-related Android permission / settings state. */
public final class CallPermissionState {
    public boolean notificationsGranted;
    public boolean cameraGranted;
    public boolean microphoneGranted;
    public boolean bluetoothGranted;
    public boolean bluetoothRequired;

    public boolean fullScreenSupported;
    public boolean fullScreenAllowed;

    public boolean appNotificationsEnabled;
    public boolean callChannelExists;
    public boolean callChannelHighImportance;
    public int callChannelImportance;
    public String callChannelId;

    public boolean batteryOptimized;

    public boolean requiredRuntimePermissionsGranted;
    public boolean incomingCallsReady;
    public boolean activeVideoCallsReady;

    public String manufacturer;
    public String model;
    public int sdkInt;
    public String applicationId;

    public JSObject toJsObject() {
        JSObject o = new JSObject();
        o.put("notificationsGranted", notificationsGranted);
        o.put("cameraGranted", cameraGranted);
        o.put("microphoneGranted", microphoneGranted);
        o.put("bluetoothGranted", bluetoothGranted);
        o.put("bluetoothRequired", bluetoothRequired);
        o.put("fullScreenSupported", fullScreenSupported);
        o.put("fullScreenAllowed", fullScreenAllowed);
        o.put("appNotificationsEnabled", appNotificationsEnabled);
        o.put("callChannelExists", callChannelExists);
        o.put("callChannelHighImportance", callChannelHighImportance);
        o.put("callChannelImportance", callChannelImportance);
        o.put("callChannelId", callChannelId != null ? callChannelId : "");
        o.put("batteryOptimized", batteryOptimized);
        o.put("requiredRuntimePermissionsGranted", requiredRuntimePermissionsGranted);
        o.put("incomingCallsReady", incomingCallsReady);
        o.put("activeVideoCallsReady", activeVideoCallsReady);
        o.put("manufacturer", manufacturer != null ? manufacturer : "");
        o.put("model", model != null ? model : "");
        o.put("sdkInt", sdkInt);
        o.put("applicationId", applicationId != null ? applicationId : "");
        return o;
    }
}
