using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Automation;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;
using System.Text;

// Invoked only by the user's QQ Music lyric switch. No global input,
// coordinates, window activation, configuration edits, or playback controls.
class DesktopLyrics {
  static readonly string Executable = Environment.GetEnvironmentVariable("CLAWD_QQMUSIC_EXECUTABLE");
  delegate bool EnumWindowCallback(IntPtr window,IntPtr value);
  [DllImport("user32.dll")]static extern bool EnumWindows(EnumWindowCallback callback,IntPtr value);
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr window,StringBuilder text,int length);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr window,StringBuilder text,int length);
  [DllImport("user32.dll")]static extern bool GetWindowPlacement(IntPtr window,ref Placement placement);
  [DllImport("user32.dll",SetLastError=true)]static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
  const uint KeepPositionAndFocus=0x0001|0x0002|0x0004|0x0010|0x0200|0x4000;
  [StructLayout(LayoutKind.Sequential)]struct Point {public int x,y;}
  [StructLayout(LayoutKind.Sequential)]struct Rect {public int left,top,right,bottom;}
  [StructLayout(LayoutKind.Sequential)]struct Placement {public int length,flags,showCmd;public Point minimum,maximum;public Rect normal;}
  class WindowInfo {public IntPtr handle;public string title,windowClass;public bool visible,minimized;public int width,height;}
  static List<WindowInfo> Windows() {
    var pids=new HashSet<uint>();
    foreach(Process process in Process.GetProcessesByName("QQMusic"))using(process){
      try{if(String.Equals(process.MainModule.FileName,Executable,StringComparison.OrdinalIgnoreCase))pids.Add((uint)process.Id);}
      catch(System.ComponentModel.Win32Exception){}catch(InvalidOperationException){}
    }
    if(pids.Count==0)throw new InvalidOperationException("请先启动QQ音乐，再读取桌面歌词状态。");
    var windows=new List<WindowInfo>();
    EnumWindows(delegate(IntPtr handle,IntPtr ignored){
      uint pid;GetWindowThreadProcessId(handle,out pid);if(!pids.Contains(pid))return true;
      var title=new StringBuilder(256);var cls=new StringBuilder(128);GetWindowText(handle,title,title.Capacity);GetClassName(handle,cls,cls.Capacity);
      var placement=new Placement();placement.length=Marshal.SizeOf(typeof(Placement));GetWindowPlacement(handle,ref placement);
      windows.Add(new WindowInfo{handle=handle,title=title.ToString(),windowClass=cls.ToString(),visible=IsWindowVisible(handle),minimized=IsIconic(handle),width=placement.normal.right-placement.normal.left,height=placement.normal.bottom-placement.normal.top});return true;
    },IntPtr.Zero);
    return windows;
  }
  static bool IsLyrics(WindowInfo window){return (window.windowClass=="TXGuiFoundation"&&window.title=="桌面歌词")||window.title=="DynamicLyricWindow";}
  static List<WindowInfo> PlayerWindows(List<WindowInfo> windows){
    return windows.FindAll(window=>!IsLyrics(window)&&window.windowClass=="TXGuiFoundation"&&window.width>=500&&window.height>=250&&window.title!="TXMenuWindow");
  }
  static bool NativeVisible(List<WindowInfo> windows){return windows.Exists(window=>IsLyrics(window)&&window.visible&&!window.minimized);}
  static Dictionary<string,object> State(List<WindowInfo> windows){
    if(!windows.Exists(IsLyrics)&&PlayerWindows(windows).Count==0)throw new InvalidOperationException("没有识别到QQ音乐播放器或桌面歌词窗口，请稍后重试。");
    return new Dictionary<string,object>{{"ok",true},{"available",true},{"visible",NativeVisible(windows)},{"canControl",windows.Exists(IsLyrics)||PlayerWindows(windows).Count>0},{"source","native-lyric-window"}};
  }
  static List<WindowInfo> VisibilityTargets(List<WindowInfo> windows,bool desired,string preferred){
    var lyrics=windows.FindAll(IsLyrics);
    if(!desired)return lyrics.FindAll(window=>window.visible&&!window.minimized);
    WindowInfo target=lyrics.Find(window=>window.title==preferred)
      ?? lyrics.Find(window=>window.title=="桌面歌词")
      ?? (lyrics.Count>0?lyrics[0]:null);
    return target==null?new List<WindowInfo>():new List<WindowInfo>{target};
  }
  static string ModeFile(){return Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"desktop-lyrics-view.json");}
  static string PreviousMode(){
    try{var mode=new JavaScriptSerializer().DeserializeObject(File.ReadAllText(ModeFile())) as string;if(mode=="桌面歌词"||mode=="DynamicLyricWindow")return mode;}catch{}
    return "桌面歌词";
  }
  static Dictionary<string,object> SetNativeVisibility(List<WindowInfo> windows,bool desired){
    var targets=VisibilityTargets(windows,desired,PreviousMode());
    if(targets.Count==0)throw new InvalidOperationException("QQ音乐尚未创建桌面歌词窗口，请先在QQ音乐中启用一次桌面歌词。");
    foreach(WindowInfo target in targets){
      // Refresh ownership immediately before changing a window. Never accept
      // caller-provided handles or target the player, queue, menus or dialogs.
      if(!Windows().Exists(window=>window.handle==target.handle&&IsLyrics(window)))throw new InvalidOperationException("歌词窗口已变化，请重试。");
      uint flags=KeepPositionAndFocus|(desired?0x0040u:0x0080u);
      if(!SetWindowPos(target.handle,IntPtr.Zero,0,0,0,0,flags))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"QQ音乐歌词窗口未接受显示操作");
    }
    for(int attempt=0;attempt<20;attempt++){
      Thread.Sleep(100);var current=Windows();
      if(NativeVisible(current)==desired){
        if(!desired)try{File.WriteAllText(ModeFile(),new JavaScriptSerializer().Serialize(targets[0].title));}catch{}
        var result=State(current);result["control"]="native-window-visibility";return result;
      }
    }
    throw new InvalidOperationException("QQ音乐歌词窗口状态没有变化，请重试。");
  }
  static AutomationElement FindButton(AutomationElement node, int depth, Stopwatch clock, ref int visited) {
    if(node==null || depth>22 || visited++>350 || clock.ElapsedMilliseconds>4500)return null;
    try {
      if(node.Current.ControlType==ControlType.Button) {
        string name=node.Current.Name;
        if(name=="打开歌词" || name=="关闭歌词" || name=="显示桌面歌词" || name=="隐藏桌面歌词")return node;
      }
      // The native player controls are at the end of QQ Music's control tree.
      // Search backwards to avoid expanding the user's entire song library.
      TreeWalker walker=TreeWalker.ControlViewWalker;
      for(AutomationElement child=walker.GetLastChild(node);child!=null;child=walker.GetPreviousSibling(child)) {
        if(clock.ElapsedMilliseconds>4500 || visited>350)break;
        AutomationElement found=FindButton(child,depth+1,clock,ref visited);if(found!=null)return found;
      }
    }catch(ElementNotAvailableException){}
    return null;
  }
  static AutomationElement FindSwitch() {
    foreach (WindowInfo window in PlayerWindows(Windows())) {
        try {
          AutomationElement root = AutomationElement.FromHandle(window.handle);
          int visited=0;AutomationElement button=FindButton(root,0,Stopwatch.StartNew(),ref visited);
          if (button != null) return button;
        } catch (ElementNotAvailableException) {} catch (System.ComponentModel.Win32Exception) {} catch (InvalidOperationException) {}
    }
    return null;
  }
  static Dictionary<string,object> Run(string action) {
    if(action!="status" && action!="control-status" && action!="show" && action!="hide")throw new ArgumentException("不支持的歌词操作");
    var windows=Windows();var state=State(windows);
    if(action=="status")return state;
    if((action=="show"&&NativeVisible(windows))||(action=="hide"&&!NativeVisible(windows)))return state;
    if(action!="control-status"&&windows.Exists(IsLyrics))return SetNativeVisibility(windows,action=="show");
    AutomationElement button=FindSwitch();
    if(button==null)throw new InvalidOperationException("歌词状态已可读取，但当前QQ音乐未提供后台开关，请打开QQ音乐主界面后再切换。");
    // Recheck after locating the control, in case QQ Music changed meanwhile.
    bool visible=NativeVisible(Windows());
    if(action!="control-status") {
      bool desired=action=="show";
      if(visible!=desired) {
        object pattern;
        if(button.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))((InvokePattern)pattern).Invoke();
        else if(button.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))((TogglePattern)pattern).Toggle();
        else throw new InvalidOperationException("当前QQ音乐不支持直接控制歌词开关，请在QQ音乐里手动设置。");
        bool confirmed=false;
        for(int attempt=0;attempt<15;attempt++) {
          Thread.Sleep(100);windows=Windows();
          if(NativeVisible(windows)==desired){visible=desired;confirmed=true;break;}
        }
        if(!confirmed)throw new InvalidOperationException("QQ音乐未确认歌词状态，请检查QQ音乐后重试。");
      }
    }
    object supportedPattern;
    bool canControl=button.TryGetCurrentPattern(InvokePattern.Pattern,out supportedPattern)
      || button.TryGetCurrentPattern(TogglePattern.Pattern,out supportedPattern);
    state["visible"]=visible;state["canControl"]=canControl;return state;
  }
  [STAThread] static int Main(string[] args) {
    Console.OutputEncoding=new System.Text.UTF8Encoding(false);
    object result;
    try { if(args.Length!=1)throw new ArgumentException("Missing lyric action");result=Run(args[0]); }
    catch(Exception error){ result=new Dictionary<string,object>{{"ok",false},{"available",false},{"error",error.Message}}; }
    Console.WriteLine(new JavaScriptSerializer().Serialize(result));return 0;
  }
}
