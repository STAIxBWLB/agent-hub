// Local AppKit/WebKit surface. No shell evaluation or remote content.
ObjC.import('Cocoa');
ObjC.import('WebKit');
var panel, web, app, viewPath, positionPath, readyPath, cliArgv, timer, bridge;
var offlineAt = 0, commands = [], exiting = false;
function ignoreCompletion(result, error) {}
function evaluate(source) { web.evaluateJavaScriptCompletionHandler(source, ignoreCompletion); }
function savePosition() {
  var origin = panel.frame.origin;
  $(JSON.stringify({ x: origin.x, y: origin.y })).writeToFileAtomicallyEncodingError(positionPath, true, $.NSUTF8StringEncoding, null);
}
function quit() { exiting = true; savePosition(); app.terminate(null); }
function runCommand(command, text, argv) {
  if (exiting || commands.length >= 8) return;
  var task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(argv[0]);
  var args = argv.slice(1).concat([command]);
  if (command === 'say') args = args.concat(['--', text]);
  task.arguments = $(args); // argv array only; message text is a single argument.
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
  if (task.launchAndReturnError(null)) commands.push({ task: task, command: command });
  else evaluate('commandResult(false)');
}
ObjC.registerSubclass({ name: 'AhubPetPanel', superclass: 'NSPanel', methods: {
  canBecomeKeyWindow: { types: ['bool', []], implementation: function() { return true; } },
  canBecomeMainWindow: { types: ['bool', []], implementation: function() { return false; } }
} });
// JXA cannot resolve WKScriptMessageHandler by name on some macOS versions;
// WebKit invokes the exact Objective-C selector on this retained subclass.
ObjC.registerSubclass({ name: 'AhubPetBridge', superclass: 'NSObject', methods: {
  'userContentController:didReceiveScriptMessage:': { types: ['void', ['id', 'id']], implementation: function(controller, message) {
    var body = ObjC.deepUnwrap(message.body);
    if (!body || typeof body !== 'object' || exiting) return;
    if (body.kind === 'ready') {
      tick();
      $('ready').writeToFileAtomicallyEncodingError(readyPath, true, $.NSUTF8StringEncoding, null);
    } else if (body.kind === 'pencil') {
      panel.orderFrontRegardless; panel.makeKeyWindow;
      evaluate('focusInput()');
    } else if (body.kind === 'drag' && typeof body.dx === 'number' && typeof body.dy === 'number' && isFinite(body.dx) && isFinite(body.dy) && Math.abs(body.dx) <= 2000 && Math.abs(body.dy) <= 2000) {
      var origin = panel.frame.origin;
      panel.setFrameOrigin($.NSMakePoint(origin.x + body.dx, origin.y - body.dy));
      savePosition();
    } else if (body.kind === 'send' && typeof body.text === 'string' && body.text.trim() && body.text.length <= 65536 && body.text.indexOf('\0') === -1) {
      runCommand('say', body.text, cliArgv);
    } else if (body.kind === 'open') runCommand('ui', undefined, cliArgv);
    else if (body.kind === 'close') quit();
  } },
  'tick:': { types: ['void', ['id']], implementation: function(sender) { tick(); } }
} });
function tick() {
  var value;
  try { value = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(viewPath, $.NSUTF8StringEncoding, null))); }
  catch (error) { value = { offline: true }; }
  evaluate('update(' + JSON.stringify(value) + ')');
  if (value.offline === true) { if (!offlineAt) offlineAt = Date.now(); if (Date.now() - offlineAt >= 2000) quit(); }
  else offlineAt = 0;
  commands = commands.filter(function(item) {
    if (item.task.isRunning) return true;
    if (item.command === 'say') evaluate('commandResult(' + (Number(item.task.terminationStatus) === 0) + ')');
    return false;
  });
}
function run(argv) {
  if (argv.length !== 3) throw new Error('Invalid pet window arguments');
  viewPath = argv[0];
  var htmlPath = argv[1];
  cliArgv = JSON.parse(argv[2]);
  if (!Array.isArray(cliArgv) || cliArgv.length !== 4 || cliArgv.some(function(arg) { return typeof arg !== 'string'; }) || cliArgv[2] !== '--project') throw new Error('Invalid CLI argv');
  var stateDir = ObjC.unwrap($(viewPath).stringByDeletingLastPathComponent);
  positionPath = stateDir + '/pet-window-pos.json';
  var owner = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(stateDir + '/pet-window.pid', $.NSUTF8StringEncoding, null)));
  readyPath = stateDir + '/pet-window-ready-' + owner.token;
  app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var screen = $.NSScreen.mainScreen.visibleFrame;
  var W = 150, H = 150;
  var origin = { x: screen.origin.x + screen.size.width - (W + 20), y: screen.origin.y + 80 };
  try {
    var saved = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(positionPath, $.NSUTF8StringEncoding, null)));
    if (typeof saved.x === 'number' && typeof saved.y === 'number' && isFinite(saved.x) && isFinite(saved.y)) origin = saved;
  } catch (error) {}
  var screens = $.NSScreen.screens;
  var visible = false;
  for (var i = 0; i < screens.count; i++) {
    var frame = screens.objectAtIndex(i).visibleFrame;
    if (origin.x >= frame.origin.x && origin.y >= frame.origin.y && origin.x + W <= frame.origin.x + frame.size.width && origin.y + H <= frame.origin.y + frame.size.height) visible = true;
  }
  if (!visible) origin = { x: screen.origin.x + screen.size.width - (W + 20), y: screen.origin.y + 80 };
  panel = $.AhubPetPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(origin.x, origin.y, W, H), $.NSWindowStyleMaskBorderless | $.NSWindowStyleMaskNonactivatingPanel, $.NSBackingStoreBuffered, false);
  panel.title = 'agent-hub pet'; panel.opaque = false; panel.backgroundColor = $.NSColor.clearColor;
  panel.level = $.NSFloatingWindowLevel;
  panel.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorStationary;
  panel.hidesOnDeactivate = false;
  panel.acceptsMouseMovedEvents = true; // accessory panels are inactive; without this :hover/pointerenter may never fire
  var config = $.WKWebViewConfiguration.alloc.init;
  bridge = $.AhubPetBridge.alloc.init;
  config.userContentController.addScriptMessageHandlerName(bridge, 'pet');
  web = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, W, H), config);
  web.setValueForKey(false, 'drawsBackground');
  panel.contentView = web;
  web.loadFileURLAllowingReadAccessToURL($.NSURL.fileURLWithPath(htmlPath), $.NSURL.fileURLWithPath(htmlPath));
  panel.orderFrontRegardless; panel.makeKeyWindow;
  timer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(1, bridge, 'tick:', null, true);
  app.run;
}
