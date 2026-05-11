% reshape() — 2-D-to-2-D reshape preserves column-major layout.

v = [1 2 3 4 5 6];
M = reshape(v, 2, 3);
disp(M);                  % [1 3 5; 2 4 6]
disp(size(M));            % [2 3]

% Reshape to a column.
c = reshape(v, 6, 1);
disp(c);
disp(size(c));            % [6 1]

% Square reshape.
A = [1 2 3 4; 5 6 7 8; 9 10 11 12];
B = reshape(A, 4, 3);
disp(B);
disp(size(B));            % [4 3]

% Reshape from row to matrix back to row.
x = reshape(B, 1, 12);
disp(x);
disp(size(x));            % [1 12]
