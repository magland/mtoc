% Implicit expansion (broadcasting): row vector + column vector
% produces an outer-product-shaped result.
row = [10 20 30];          % 1x3
col = [1; 2];              % 2x1
S = row + col;             % 2x3
disp(S);

D = row - col;
disp(D);

P = row .* col;
disp(P);

Q = col ./ row;
disp(Q);
