% Cross-runner coverage for `assert(cond)`. The success path should
% print every disp before exit; the failing path is exercised by a
% unit test in tests/translate.test.ts (cross-runner only sees
% byte-for-byte stdout, and a deliberate failure here would diverge
% between numbl and mtoc by exit code).
assert(1 + 1 == 2);
disp(1);
assert(0.1 + 0.2 - 0.3 < 1e-9);
disp(2);
x = 5;
assert(x > 0);
assert(x ~= 4);
assert(x == 5);
disp('ok');
