% Broadcasting over a 3-D tensor: a 2-D matrix broadcasts to a 3-D
% tensor across the third axis.
v = [1 2 3 4 5 6 7 8 9 10 11 12];
A = reshape(v, 2, 3, 2);   % 2x3x2

M = [10 20 30; 40 50 60];  % 2x3 - lifts to 2x3x1 then broadcasts
S = A + M;
disp(S);

% Column-broadcast inside the 3-D tensor.
c = [100; 200];            % 2x1 - lifts to 2x1x1
T = A + c;
disp(T);
