s.a = 10;
s.b = 20;
f = @(x) x + s.a + s.b;
disp(f(5));

% Reassigning the struct after the @-site doesn't affect the snapshot.
s.a = 99;
s.b = 99;
disp(f(0));
