% zeros() — 0-arg scalar, 1-arg square, 2+ arg N-D.

disp(zeros());            % 0

a = zeros(3);
disp(a);                  % 3x3 zeros
disp(size(a));            % [3 3]

b = zeros(2, 4);
disp(b);                  % 2x4 zeros
disp(size(b));            % [2 4]

c = zeros(2, 3, 2);
disp(c);                  % 3-D zeros, two 2x3 pages
disp(size(c));            % [2 3 2]
disp(numel(c));           % 12
