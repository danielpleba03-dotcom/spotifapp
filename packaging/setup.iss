#ifndef AppSourceDir
  #define AppSourceDir "..\dist"
#endif
#ifndef AppOutputDir
  #define AppOutputDir "..\dist"
#endif

[Setup]
AppId={{C19CD0A3-C069-47F8-8E74-DC310A590248}
AppName=Spotify P
AppVersion=1.1.0
AppPublisher=danielpleba03-dotcom
AppPublisherURL=https://github.com/danielpleba03-dotcom/spotifapp
AppSupportURL=https://github.com/danielpleba03-dotcom/spotifapp/issues
DefaultDirName={localappdata}\Programs\SpotifyP
DefaultGroupName=Spotify P
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#AppOutputDir}
OutputBaseFilename=SpotifyP-Setup
SetupIconFile={#AppSourceDir}\SpotifyP.ico
UninstallDisplayIcon={app}\SpotifyP.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Languages]
Name: "italian"; MessagesFile: "compiler:Languages\Italian.isl"

[Tasks]
Name: "desktopicon"; Description: "Crea un'icona sul desktop"; Flags: unchecked

[Files]
Source: "{#AppSourceDir}\SpotifyP.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppSourceDir}\LEGGIMI.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Spotify P"; Filename: "{app}\SpotifyP.exe"
Name: "{userdesktop}\Spotify P"; Filename: "{app}\SpotifyP.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\SpotifyP.exe"; Description: "Avvia Spotify P"; Flags: nowait postinstall skipifsilent
