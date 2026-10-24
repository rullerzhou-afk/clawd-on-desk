using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Automation;

// Reads accessibility state. Quiet playback only hides QQ Music's exact launch
// notification; never invokes a control, sends input, or changes the main window.
class QQMusicLibrary {
  static readonly string Exe=Environment.GetEnvironmentVariable("CLAWD_QQMUSIC_EXECUTABLE");
  const int Button=50000,Text=50020,Pane=50033;
  delegate bool Callback(IntPtr hwnd,IntPtr data);
  [DllImport("user32.dll")]static extern bool EnumWindows(Callback cb,IntPtr p);
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint id);
  [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]static extern bool ShowWindowAsync(IntPtr hwnd,int command);
  delegate void WinEvent(IntPtr hook,uint evt,IntPtr hwnd,int obj,int child,uint thread,uint time);
  [DllImport("user32.dll")]static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,WinEvent callback,uint process,uint thread,uint flags);
  [DllImport("user32.dll")]static extern bool UnhookWinEvent(IntPtr hook);
  [StructLayout(LayoutKind.Sequential)]struct Message{public IntPtr hwnd;public uint message;public UIntPtr wParam;public IntPtr lParam;public uint time;public int x,y;}
  [DllImport("user32.dll")]static extern bool PeekMessage(out Message message,IntPtr hwnd,uint min,uint max,uint remove);
  [DllImport("user32.dll")]static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll")]static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr hwnd,StringBuilder name,int count);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr hwnd,StringBuilder name,int count);
  static readonly HashSet<string> Labels=new HashSet<string>{"播放队列","顺序播放","单曲循环","随机播放","列表循环"};
  static void QuietGuard(){
    var ids=new HashSet<uint>();foreach(var p in Process.GetProcessesByName("QQMusic"))using(p){try{if(String.Equals(p.MainModule.FileName,Exe,StringComparison.OrdinalIgnoreCase))ids.Add((uint)p.Id);}catch{}}
    if(ids.Count==0)throw new Exception("请先启动 QQ 音乐");
    Action<IntPtr> hide=delegate(IntPtr h){uint id;GetWindowThreadProcessId(h,out id);if(!ids.Contains(id))return;var title=new StringBuilder(128);GetWindowText(h,title,title.Capacity);if(title.ToString()!="已开始播放提示")return;var type=new StringBuilder(128);GetClassName(h,type,type.Capacity);if(type.ToString()=="TXGuiFoundation"&&IsWindowVisible(h))ShowWindowAsync(h,0);};
    WinEvent callback=delegate(IntPtr hook,uint evt,IntPtr h,int obj,int child,uint thread,uint time){if(obj==0&&child==0)hide(h);};
    var hooks=new List<IntPtr>();
    try{
      foreach(uint id in ids){var hook=SetWinEventHook(0x8002,0x800C,IntPtr.Zero,callback,id,0,0);if(hook==IntPtr.Zero)throw new Exception("无法启用后台切歌保护");hooks.Add(hook);}
      EnumWindows(delegate(IntPtr h,IntPtr ignored){hide(h);return true;},IntPtr.Zero);
      Console.WriteLine("READY");Console.Out.Flush();
      var watch=Stopwatch.StartNew();while(watch.ElapsedMilliseconds<4000){Message message;while(PeekMessage(out message,IntPtr.Zero,0,0,1)){TranslateMessage(ref message);DispatchMessage(ref message);}System.Threading.Thread.Sleep(5);}
    }finally{foreach(var hook in hooks)UnhookWinEvent(hook);GC.KeepAlive(callback);}
  }
  static object WindowState(){
    var ids=new HashSet<uint>();foreach(var p in Process.GetProcessesByName("QQMusic"))using(p){try{if(String.Equals(p.MainModule.FileName,Exe,StringComparison.OrdinalIgnoreCase))ids.Add((uint)p.Id);}catch{}}
    var windows=new List<object>();EnumWindows(delegate(IntPtr h,IntPtr ignored){uint id;GetWindowThreadProcessId(h,out id);if(ids.Contains(id)){var type=new StringBuilder(128);GetClassName(h,type,type.Capacity);if(type.ToString()=="TXGuiFoundation"){
      var caption=new StringBuilder(256);GetWindowText(h,caption,caption.Capacity);var text=new List<string>();
      if(IsWindowVisible(h)&&caption.Length==0)try{var nodes=AutomationElement.FromHandle(h).FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Text));for(int i=0;i<nodes.Count&&i<12;i++)if(!String.IsNullOrWhiteSpace(nodes[i].Current.Name))text.Add(nodes[i].Current.Name);}catch{}
      windows.Add(new{window=h.ToInt64(),title=caption.ToString(),visible=IsWindowVisible(h),minimized=IsIconic(h),text});
    }}return true;},IntPtr.Zero);
    var foreground=GetForegroundWindow();uint owner;GetWindowThreadProcessId(foreground,out owner);
    return new{foreground=foreground.ToInt64(),qqMusicForeground=ids.Contains(owner),windows};
  }
  static string TypeName(int type){return type==Button?"ControlType.Button":type==Text?"ControlType.Text":"ControlType.Custom";}
  static List<object> Snapshot(){
    var ids=new HashSet<uint>();
    foreach(var p in Process.GetProcessesByName("QQMusic"))using(p){try{if(String.Equals(p.MainModule.FileName,Exe,StringComparison.OrdinalIgnoreCase))ids.Add((uint)p.Id);}catch{}}
    var result=new List<object>();
    EnumWindows(delegate(IntPtr h,IntPtr ignored){
      uint id;GetWindowThreadProcessId(h,out id);if(!ids.Contains(id))return true;
      var caption=new StringBuilder(256);GetWindowText(h,caption,caption.Capacity);bool isQueue=caption.ToString()=="播放队列";
      if(!isQueue&&!IsWindowVisible(h))return true;
      var className=new StringBuilder(128);GetClassName(h,className,className.Capacity);
      if(className.ToString()!="TXGuiFoundation"&&!isQueue)return true;
      try{
        var root=AutomationElement.FromHandle(h);var rows=new List<object>();
        var cache=new CacheRequest();cache.Add(AutomationElement.NameProperty);cache.Add(AutomationElement.ControlTypeProperty);
        var all=Condition.TrueCondition;
        AutomationElementCollection nodes;using(cache.Activate()){nodes=root.FindAll(TreeScope.Descendants,all);}
        for(int i=0;i<nodes.Count&&i<15000;i++){
          var e=nodes[i];string name=(e.Cached.Name??"").Trim();int type=e.Cached.ControlType.Id;
          if((type==Button&&Labels.Contains(name))||(type==Text&&Regex.IsMatch(name??"",@"^115292[0-9]{12,14}$"))||Regex.IsMatch(name??"",@"^\d{1,2}:\d{2}(:\d{2})?$"))rows.Add(new{name,type=TypeName(type)});
        }
        if(isQueue){
          var songs=new List<object>();string countText="";
          var texts=root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Text));
          for(int i=0;i<texts.Count;i++){string name=texts[i].Current.Name;if(Regex.IsMatch(name??"",@"^共\d+首歌曲$"))countText=name;}
          var panes=root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Pane));
          for(int i=0;i<panes.Count;i++){
            var children=panes[i].FindAll(TreeScope.Children,all);string artist="",title="";
            for(int j=0;j<children.Count;j++)if(children[j].Current.ControlType.Id==Text)artist=children[j].Current.Name;
            if(String.IsNullOrEmpty(artist))continue;
            for(int j=0;j<children.Count;j++)if(children[j].Current.ControlType.Id==Pane){var names=children[j].FindAll(TreeScope.Children,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Text));if(names.Count>0){title=names[0].Current.Name;break;}}
            if(!String.IsNullOrEmpty(title))songs.Add(new{title,artist,orderY=panes[i].Current.BoundingRectangle.Top});
          }
          result.Add(new{window=h.ToInt64(),title=caption.ToString(),visible=IsWindowVisible(h),countText,items=songs,rows});
        }else if(rows.Count>0)result.Add(new{window=h.ToInt64(),title=caption.ToString(),minimized=IsIconic(h),rows});
      }catch{}
      return true;
    },IntPtr.Zero);
    return result;
  }
  [MTAThread]static void Main(string[] args){
    Console.OutputEncoding=new UTF8Encoding(false);var json=new JavaScriptSerializer();
    try{
      if(args.Length==1&&args[0]=="quiet-guard"){QuietGuard();return;}
      if(args.Length==1&&args[0]=="window-state"){Console.WriteLine(json.Serialize(WindowState()));return;}
      if(args.Length!=1||args[0]!="snapshot")throw new Exception("不支持的读取操作");
      Console.WriteLine(json.Serialize(new{ok=true,windows=Snapshot()}));
    }catch(Exception e){Console.WriteLine(json.Serialize(new{ok=false,error=e.Message}));Environment.ExitCode=1;}
  }
}
