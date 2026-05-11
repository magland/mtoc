% ones() — 0-arg scalar, 1-arg square, 2+ arg N-D.

disp(ones());             % 1

a = ones(2);
disp(a);                  % 2x2 ones
disp(sum(a(:)));          % 4

b = ones(3, 4);
disp(b);                  % 3x4 ones
disp(sum(b(:)));          % 12

c = ones(2, 2, 3);
disp(c);                  % 3 pages of 2x2 ones
disp(numel(c));           % 12
