using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace ClawdQQMusic {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorObject {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(ref Guid session, uint flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(ref Guid session, uint flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
  }
  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
    [PreserveSig] int GetGroupingParam(out Guid grouping);
    [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint pid);
  }
  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float value, ref Guid context);
    [PreserveSig] int GetMasterVolume(out float value);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  public class AudioState { public int Sessions; public double Volume = -1; public bool Muted; }
  public static class SessionVolume {
    static void Check(int hr) { Marshal.ThrowExceptionForHR(hr); }
    static void Release(object obj) { if(obj != null && Marshal.IsComObject(obj)) Marshal.ReleaseComObject(obj); }
    public static AudioState Run(string action, double value) {
      if(action != "status" && action != "set-volume" && action != "volume-up" && action != "volume-down" && action != "mute") throw new ArgumentException("Unknown audio action");
      if(action == "set-volume" && (Double.IsNaN(value) || Double.IsInfinity(value) || value < 0 || value > 100)) throw new ArgumentException("Volume must be 0-100");
      var result = new AudioState();
      object enumeratorObject = new MMDeviceEnumeratorObject();
      IMMDeviceCollection devices = null;
      try {
        Check(((IMMDeviceEnumerator)enumeratorObject).EnumAudioEndpoints(0, 1, out devices));
        uint count; Check(devices.GetCount(out count));
        bool? targetMute = null;
        for(uint d=0; d<count; d++) {
          IMMDevice device = null; object managerObject = null; IAudioSessionEnumerator sessions = null;
          try {
            Check(devices.Item(d, out device));
            Guid iid = typeof(IAudioSessionManager2).GUID;
            Check(device.Activate(ref iid, 23, IntPtr.Zero, out managerObject));
            Check(((IAudioSessionManager2)managerObject).GetSessionEnumerator(out sessions));
            int sessionCount; Check(sessions.GetCount(out sessionCount));
            for(int s=0; s<sessionCount; s++) {
              object sessionObject = null;
              try {
                Check(sessions.GetSession(s, out sessionObject));
                var control = (IAudioSessionControl2)sessionObject;
                uint pid; Check(control.GetProcessId(out pid));
                if(pid == 0) continue;
                try { using(var process=Process.GetProcessById((int)pid)) { if(!String.Equals(process.ProcessName,"QQMusic",StringComparison.OrdinalIgnoreCase)) continue; } }
                catch(ArgumentException) { continue; }
                int state; Check(control.GetState(out state)); if(state == 2) continue;
                var volume = (ISimpleAudioVolume)sessionObject;
                float level; bool mute; Check(volume.GetMasterVolume(out level)); Check(volume.GetMute(out mute));
                Guid context = Guid.Empty;
                if(action == "set-volume") Check(volume.SetMasterVolume((float)(value/100),ref context));
                if(action == "volume-up" || action == "volume-down") Check(volume.SetMasterVolume(Math.Max(0,Math.Min(1,level+(action=="volume-up"?0.05f:-0.05f))),ref context));
                if(action == "mute") { if(!targetMute.HasValue) targetMute = !mute; Check(volume.SetMute(targetMute.Value,ref context)); }
                Check(volume.GetMasterVolume(out level)); Check(volume.GetMute(out mute));
                result.Sessions++;
                if(result.Volume < 0) { result.Volume = Math.Round(level*100); result.Muted = mute; }
              } finally { Release(sessionObject); }
            }
          } finally { Release(sessions); Release(managerObject); Release(device); }
        }
      } finally { Release(devices); Release(enumeratorObject); }
      return result;
    }
  }
}
