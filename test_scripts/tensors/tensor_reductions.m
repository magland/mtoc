v = [1 2 3 4 5];
disp(sum(v));
disp(length(v));
disp(numel(v));

c = [10; 20; 30];
disp(sum(c));
disp(length(c));
disp(numel(c));

m = [1 2 3; 4 5 6];
disp(length(m));
disp(numel(m));
disp(sum(m));

% sum over a vector built from arithmetic
a = [1 2 3];
b = [4 5 6];
ab = a .* b;
disp(sum(ab));
