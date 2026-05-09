M = [1 2 3; 4 5 6];
% 2D indexing
disp(M(1, 1));
disp(M(2, 3));
disp(M(1, end));
disp(M(end, 1));
disp(M(end, end));
% Linear (column-major) indexing
disp(M(1));
disp(M(2));
disp(M(3));
disp(M(4));
disp(M(5));
disp(M(6));
disp(M(end));
% Mixed-axis end
disp(M(end, 2));
disp(M(1, end - 1));
