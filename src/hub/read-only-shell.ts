/** Lexical data only. A successful parse grants no permission and proves no program read-only. */
export interface SimpleShellWords {
  words: readonly string[];
  /** Syntax-looking characters survived as quoted/escaped data; the grant policy must decide whether to accept them. */
  quotedMeta: boolean;
}
export const READ_ONLY_SHELL_LIMITS = { characters: 4000, words: 128 } as const;
const ACTIVE = ";|&<>`$(){}*?[]~#";

/** One bounded literal command, without active operators or expansion. Never executes or resolves any word. */
export function parseSimpleShell(command: unknown): SimpleShellWords | undefined {
  if (typeof command !== "string" || command.length > READ_ONLY_SHELL_LIMITS.characters
    || command.includes("\n") || command.includes("\r") || command.includes("\0")) return undefined;
  const words: string[] = [];
  let word = "", started = false, quote: "" | "'" | '"' = "", quotedMeta = false;
  const append = (character: string, literal = false) => {
    word += character;
    started = true;
    if (literal && (ACTIVE.includes(character) || character === "\\")) quotedMeta = true;
  };
  const finish = () => {
    if (!started) return true;
    words.push(word);
    word = ""; started = false;
    return words.length <= READ_ONLY_SHELL_LIMITS.words;
  };
  for (let i = 0; i < command.length; i++) {
    const character = command[i]!;
    if (quote === "'") {
      if (character === "'") quote = "";
      else append(character, true);
      continue;
    }
    if (quote === '"') {
      if (character === '"') { quote = ""; continue; }
      if (character === "$" || character === "`") return undefined;
      if (character === "\\") return undefined;
      append(character, true);
      continue;
    }
    if (character === " " || character === "\t") { if (!finish()) return undefined; continue; }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (character === "\\") {
      const next = command[++i];
      if (next === undefined) return undefined;
      append(next, true);
      continue;
    }
    if (ACTIVE.includes(character) && !(character === "~" && started)) return undefined;
    append(character);
  }
  if (quote || !finish() || !words.length) return undefined;
  if (/^[A-Za-z_][A-Za-z0-9_]*[+]?=/.test(words[0]!)) return undefined;
  return { words, quotedMeta };
}

export const READ_ONLY_PROGRAMS = ["ls","cat","head","tail","wc","rg","grep","stat","file","tree","pwd","find","git"] as const;
export type ReadOnlyProgram = typeof READ_ONLY_PROGRAMS[number];
export interface ReadOnlyShellForm { program:ReadOnlyProgram; paths:readonly string[]; gitCwd?:string }
type FlagKind = "none"|"number"|"pattern"|"path";
const flags=(none:string[],values:Record<string,FlagKind>={}):Record<string,FlagKind>=>Object.assign(Object.fromEntries(none.map(flag=>[flag,"none"])),values);
const numberArg=(value:string)=>/^[0-9]{1,7}$/.test(value) && Number(value)<=1_000_000;
function options(args:string[],rules:Record<string,FlagKind>,path:(value:string)=>void) {
  const positional:string[]=[],seen=new Set<string>();let ended=false;
  for(let i=0;i<args.length;i++) {
    const word=args[i]!;
    if(!ended && word==="--"){ended=true;continue;}
    if(ended || !word.startsWith("-") || word==="-"){positional.push(word);continue;}
    let key=word,value:string|undefined;
    if(word.startsWith("--") && word.includes("=")){const at=word.indexOf("=");key=word.slice(0,at);value=word.slice(at+1);}
    if(!Object.hasOwn(rules,key) && /^-[^-].+/.test(word)) {
      const letters=word.slice(1);let consumed=false;
      for(let n=0;n<letters.length;n++) {
        const short=`-${letters[n]}`;
        if(!Object.hasOwn(rules,short))return undefined;
        seen.add(short);
        if(rules[short]!=="none") {key=short;value=letters.slice(n+1)||args[++i];consumed=true;break;}
      }
      if(!consumed)continue;
    }
    if(!Object.hasOwn(rules,key))return undefined;
    seen.add(key);const kind=rules[key]!;
    if(kind==="none"){if(value!==undefined)return undefined;continue;}
    value??=args[++i];if(value===undefined || value.startsWith("-") || kind==="number"&&!numberArg(value))return undefined;
    if(kind==="path")path(value);
  }
  return {positional,seen};
}

/** Structural allowlist only; the host must still prove executable identity, paths, config and current authority. */
export function readOnlyShellForm(command:unknown,root:string,readPath:(path:string,base?:string)=>string):ReadOnlyShellForm|undefined {
  try {
    const parsed=parseSimpleShell(command);if(!parsed)return undefined;
    const [name,...args]=parsed.words;
    if(!READ_ONLY_PROGRAMS.includes(name as ReadOnlyProgram))return undefined;
    const program=name as ReadOnlyProgram,paths:string[]=[];
    const path=(value:string,base=root)=>{if(value!=="-")paths.push(readPath(value,base));};
    path(".");
    if(program==="git") {
      let cwd=root,i=0;
      while(i<args.length){if(args[i]==="--no-pager"||args[i]==="--no-optional-locks"){i++;continue;}if(args[i]==="-C"&&args[i+1]!==undefined){cwd=readPath(args[i+1]!,cwd);paths.push(cwd);i+=2;continue;}break;}
      const sub=args[i++],rest=args.slice(i);
      const ref=(value:string)=>{
        if(!value || value.startsWith("-") || value.startsWith("/") || value.startsWith("~") || value.includes("..")&&value.startsWith("."))throw new Error("unknown revision");
        if(value.startsWith(":") || /[*?\[\]]/.test(value))throw new Error("unresolved pathspec");
        const colon=value.indexOf(":");if(colon>=0)path(value.slice(colon+1),cwd);else path(value,cwd);
      };
      if(sub==="branch") {if(rest[0]!=="--list" || rest.slice(1).some(a=>a.startsWith("-")))return undefined;return {program,paths,gitCwd:cwd};}
      if(sub==="cat-file") {if(rest.length!==2||!["-p","-t","-s"].includes(rest[0]!))return undefined;ref(rest[1]!);return {program,paths,gitCwd:cwd};}
      // These commands do not accept both required diff-disabling flags, so their shell forms keep asking.
      if(sub==="blame"||sub==="grep")return undefined;
      let rule:Record<string,FlagKind>;
      if(sub==="status")rule=flags(["-s","-b","--short","--branch","--porcelain","--ignored"],{"--untracked-files":"pattern"});
      else if(sub==="rev-parse")rule=flags(["--show-toplevel","--git-dir","--is-inside-work-tree","--show-prefix","--verify","--short"]);
      else if(sub==="ls-files")rule=flags(["-z","--cached","--deleted","--modified","--others","--exclude-standard","--stage","--error-unmatch"]);
      else if(sub==="describe")rule=flags(["--always","--tags","--long","--all","--dirty"],{"--abbrev":"number","--match":"pattern","--exclude":"pattern"});
      else if(sub==="log"||sub==="diff"||sub==="show") {
        rule=flags(["--no-ext-diff","--no-textconv","--no-patch","--oneline","--all","--decorate","--no-decorate","--name-only","--name-status","--stat","-p","--patch","--cached","--staged"],{"-n":"number","--max-count":"number","--format":"pattern","--pretty":"pattern"});
      } else return undefined;
      const parsedArgs=options(rest,rule,value=>path(value,cwd));if(!parsedArgs)return undefined;
      const patch=sub==="diff" || sub==="show" || sub==="log" && ["-p","--patch","--stat"].some(flag=>parsedArgs.seen.has(flag));
      if(patch && !(parsedArgs.seen.has("--no-ext-diff")&&parsedArgs.seen.has("--no-textconv")))return undefined;
      for(const value of parsedArgs.positional)ref(value);
      return {program,paths,gitCwd:cwd};
    }
    if(program==="find") {
      let i=0,depth=0;while(i<args.length && !args[i]!.startsWith("-") && !["(",")","!"].includes(args[i]!))path(args[i++]!);
      for(;i<args.length;i++) {
        const value=args[i]!;
        if(value==="("){if(++depth>16)return undefined;continue;}if(value===")"){if(--depth<0)return undefined;continue;}
        if(["!","-a","-o","-not","-print","-print0","-ls","-depth"].includes(value))continue;
        if(["-name","-iname","-path","-ipath","-regex","-iregex"].includes(value)){if(args[++i]===undefined)return undefined;continue;}
        if(value==="-type"){if(!["f","d","l","b","c","p","s"].includes(args[++i]??""))return undefined;continue;}
        if(["-maxdepth","-mindepth"].includes(value)){if(!numberArg(args[++i]??""))return undefined;continue;}
        if(["-newer","-samefile"].includes(value)){if(args[i+1]===undefined)return undefined;path(args[++i]!);continue;}
        return undefined;
      }
      return depth===0?{program,paths}:undefined;
    }
    let rule:Record<string,FlagKind>;
    if(program==="ls")rule=flags(["-a","-A","-l","-h","-1","-d","-F","-i","-p","-r","-R","-s","-S","-t","-u"]);
    else if(program==="cat")rule=flags(["-b","-e","-n","-s","-t","-u","-v"]);
    else if(program==="head"||program==="tail")rule=flags(["-q","-v"],{"-n":"number","-c":"number","--lines":"number","--bytes":"number"});
    else if(program==="wc")rule=flags(["-c","-l","-m","-w","-L"]);
    else if(program==="stat")rule=flags(["-L"]);
    else if(program==="file")rule=flags(["-b","-i","-L","-h"]);
    else if(program==="pwd")rule=flags(["-L","-P"]);
    else if(program==="tree")rule=flags(["-a","-d","-f","-i","-p","-s","-h","-D","-F","-q","-N","-n","--noreport","--dirsfirst"],{"-L":"number","-I":"pattern","-P":"pattern"});
    else if(program==="rg")rule=flags(["-n","-l","-i","-w","-s","-S","-F","-v","-H","-h","-o","-0","-q","-c","-u","-U","-a","--files","--hidden","--no-ignore","--no-heading","--line-number","--files-with-matches","--count","--ignore-case","--fixed-strings"],{"-e":"pattern","--regexp":"pattern","-f":"path","--file":"path","-g":"pattern","--glob":"pattern","--iglob":"pattern","-t":"pattern","--type":"pattern","-T":"pattern","--type-not":"pattern","-m":"number","--max-count":"number","--max-depth":"number","-A":"number","-B":"number","-C":"number"});
    else if(program==="grep")rule=flags(["-n","-l","-i","-w","-x","-F","-E","-v","-H","-h","-o","-c","-q","-s","-r"],{"-e":"pattern","-f":"path","-A":"number","-B":"number","-C":"number","-m":"number","--include":"pattern","--exclude":"pattern","--exclude-dir":"pattern"});
    else return undefined;
    const parsedArgs=options(args,rule,path);if(!parsedArgs)return undefined;
    const operands=[...parsedArgs.positional];
    if(program==="pwd" && operands.length)return undefined;
    if(program==="rg"||program==="grep") {
      const pattern=parsedArgs.seen.has("-e")||parsedArgs.seen.has("--regexp")||parsedArgs.seen.has("-f")||parsedArgs.seen.has("--file")||parsedArgs.seen.has("--files");
      if(!pattern && operands.shift()===undefined)return undefined;
    }
    for(const value of operands)path(value);
    return {program,paths};
  } catch {return undefined;}
}
