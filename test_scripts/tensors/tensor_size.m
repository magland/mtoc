% size() — both 1-arg (row vector of dim sizes) and 2-arg (scalar
% per-dim) forms, across scalar / row / column / matrix bases.
%
% mtoc requires owned tensor expressions to be named before disp,
% so the 1-arg form is assigned to a local first.

s = 5;
sz = size(s);
disp(sz);                     % [1 1]
disp(size(s, 1));             % 1
disp(size(s, 2));             % 1
disp(size(s, 3));             % 1 (implicit trailing singleton)

r = [1 2 3 4];
sz = size(r);
disp(sz);                     % [1 4]
disp(size(r, 1));             % 1
disp(size(r, 2));             % 4

c = [10; 20; 30];
sz = size(c);
disp(sz);                     % [3 1]
disp(size(c, 1));             % 3
disp(size(c, 2));             % 1

M = [1 2 3; 4 5 6];
sz = size(M);
disp(sz);                     % [2 3]
disp(size(M, 1));             % 2
disp(size(M, 2));             % 3
disp(size(M, 4));             % 1
