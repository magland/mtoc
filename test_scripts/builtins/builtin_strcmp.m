% Cross-runner coverage for strcmp on char arrays and strings.
% (Empty char literals '' aren't supported by mtoc yet; use empty
% string literals "" instead for the empty case.)
a = 'hello';
disp(strcmp(a, 'hello'));
disp(strcmp(a, 'world'));
disp(strcmp(a, 'hell'));
s = "hello";
disp(strcmp(s, "hello"));
disp(strcmp(s, "world"));
disp(strcmp("", ""));
disp(strcmp('hi', "hi"));
disp(strcmp("hi", 'hi'));
disp(strcmp('hi', "hello"));
