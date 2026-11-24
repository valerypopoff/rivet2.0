# Strict release commands use a kernel job so descendants cannot escape when
# their immediate parent exits. No credentials or command text are evaluated.
$ErrorActionPreference = 'Stop'
try {
  $ownedPlan = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RIVET_OWNED_COMMAND_PLAN)) | ConvertFrom-Json
  Remove-Item Env:RIVET_OWNED_COMMAND_PLAN
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Threading;
public static class RivetOwnedCommand {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x,y,xSize,ySize,xCount,yCount,fill,flags;
    public short show,reservedSize; public IntPtr reservedBytes,stdin,stdout,stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long processTime,jobTime; public uint flags;
    public UIntPtr minWorking,maxWorking; public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong readOp,writeOp,otherOp,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public Limits basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits info,int size);
  [DllImport("kernel32",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,int size,IntPtr length);
  [DllImport("kernel32",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupEx startup,out ProcessInfo info);
  [DllImport("kernel32")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool result) { if(!result) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') {slashes++;continue;}
      if(c=='"') b.Append('\\',slashes*2+1); else b.Append('\\',slashes);
      b.Append(c); slashes=0;
    }
    return b.Append('\\',slashes*2).Append('"').ToString();
  }
  public static int Run(string program,string[] args,string directory,bool retainOnFailure) {
    IntPtr job=IntPtr.Zero,list=IntPtr.Zero,jobPointer=IntPtr.Zero,handlePointer=IntPtr.Zero; ProcessInfo child=new ProcessInfo();
    try {
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      var limits=new ExtendedLimits(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)));
      IntPtr bytes=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref bytes);
      list=Marshal.AllocHGlobal(bytes); Check(InitializeProcThreadAttributeList(list,2,0,ref bytes));
      jobPointer=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobPointer,job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST: assign during creation, never create a
      // suspended unowned child. Supported on Windows 10 / Server 2016 onward.
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000d),jobPointer,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      var startup=new StartupEx(); startup.startup.cb=Marshal.SizeOf(startup); startup.startup.flags=0x100;
      startup.startup.stdin=GetStdHandle(-10); startup.startup.stdout=GetStdHandle(-11); startup.startup.stderr=GetStdHandle(-12); startup.attributes=list;
      // Do not leak another inheritable copy of the owner's output pipes into
      // detached observers. Otherwise their lifetime prevents owner close.
      handlePointer=Marshal.AllocHGlobal(IntPtr.Size*3);
      Marshal.WriteIntPtr(handlePointer,0,startup.startup.stdin);
      Marshal.WriteIntPtr(handlePointer,IntPtr.Size,startup.startup.stdout);
      Marshal.WriteIntPtr(handlePointer,IntPtr.Size*2,startup.startup.stderr);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handlePointer,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
      var command=new StringBuilder(Quote(program)); foreach(string arg in args) command.Append(' ').Append(Quote(arg));
      Check(CreateProcess(program,command,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x8000000,IntPtr.Zero,directory,ref startup,out child));
      CloseHandle(child.thread); child.thread=IntPtr.Zero;
      Check(WaitForSingleObject(child.process,0xffffffff)==0);
      uint code; Check(GetExitCodeProcess(child.process,out code));
      // Journaled release failures can intentionally retain the original
      // acceptance observer. Cancellation kills this owner before this branch,
      // retaining KILL_ON_JOB_CLOSE; it never grants a successful result.
      if(code!=0 && retainOnFailure) {
        limits.basic.flags=0;
        Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits)));
        return unchecked((int)code);
      }
      Check(TerminateJobObject(job,1));
      var deadline=DateTime.UtcNow.AddSeconds(5);
      for(;;) {
        Accounting accounting; Check(QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
        if(accounting.active==0) break;
        if(DateTime.UtcNow>=deadline) throw new Exception("Owned process settlement is unconfirmed.");
        Thread.Sleep(10);
      }
      return unchecked((int)code);
    } finally {
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(child.process!=IntPtr.Zero) CloseHandle(child.process);
      if(list!=IntPtr.Zero) {DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}
      if(jobPointer!=IntPtr.Zero) Marshal.FreeHGlobal(jobPointer);
      if(handlePointer!=IntPtr.Zero) Marshal.FreeHGlobal(handlePointer);
      if(job!=IntPtr.Zero) CloseHandle(job);
    }
  }
}
'@
  exit [RivetOwnedCommand]::Run($ownedPlan.program, [string[]]$ownedPlan.args, $ownedPlan.cwd, [bool]$ownedPlan.retainOnFailure)
} catch {
  [Console]::Error.WriteLine('Owned release process failed or its local shutdown is unconfirmed.')
  exit 1
}
