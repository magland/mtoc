% Broadcasting on complex operands.
row = [1+1i, 2-1i, 3+0i];   % 1x3 complex
col = [10; 20];             % 2x1 real
S = row + col;              % 2x3 complex
disp(S);

P = row .* col;
disp(P);

% Complex column vs real row.
cc = [1i; 2i];              % 2x1 complex
rr = [3 4 5];               % 1x3 real
T = cc - rr;
disp(T);
