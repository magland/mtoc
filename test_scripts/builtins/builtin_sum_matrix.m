% sum(M) over a matrix: returns a row vector of per-column sums
% (numbl's default-dim reduction along the first non-singleton axis,
% i.e. dim 1 for any statically-known matrix).

M = [1 2 3; 4 5 6];
disp(sum(M));            % [5 7 9]

% Square matrix.
A = [1 2; 3 4];
disp(sum(A));            % [4 6]

% Negative entries.
B = [1 -2 3; -4 5 -6; 7 -8 9];
disp(sum(B));            % [4 -5 6]

% Matrix built from arithmetic — the Binary `x + y` isn't an owned
% producer on its own, so we assign it to a name first (same idiom as
% disp(x + y)). sum then accepts the named matrix.
x = [1 2 3; 4 5 6];
y = [10 20 30; 40 50 60];
xy = x + y;
disp(sum(xy));

% Complex matrix → complex row vector.
Z = [1+1i, 2-2i; 3+0i, 4+4i];
disp(sum(Z));            % [4+1i, 6+2i]

% Pure-imaginary entries.
I2 = [0+1i, 0+2i; 0+3i, 0+4i];
disp(sum(I2));
