% foo.m declares `function bar(x)` but is called as `foo(...)`:
% numbl uses the first top-level function regardless of its declared
% name, so this should work.
disp(foo(5));
