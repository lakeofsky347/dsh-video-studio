export interface CliLaunch { command:string; prefixArgs:string[]; sourcePath:string; }
export function resolveDshCli(options?:{env?:NodeJS.ProcessEnv;platform?:NodeJS.Platform;cwd?:string;nodeExecutable?:string;macDefault?:string}):CliLaunch;
export function ensureDirectoryLink(target:string,link:string,options?:{platform?:NodeJS.Platform}):void;
export function linkHostDependencies(root:string,hostNodeModules:string):number;
