% Elementwise comparisons with broadcasting.
row = [1 2 3 4];
col = [1; 2; 3];
E = row == col;
disp(E);

L = row < col;
disp(L);

G = row >= col;
disp(G);
